// Integration: controller removal API (single, multi, stale) against a real server.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startServer } = require("./e2e/server");

let srv;
const daysAgo = (d) => new Date(Date.now() - d * 86_400_000).toISOString();

// Loopback addresses: nothing listens on :80 there, so discovery probes fail fast.
// 127.0.0.1 is the UDP sender, so its logs land under a known controller IP.
const seeded = [
  { ip: "127.0.0.1", name: "sender", last_seen: daysAgo(1) },
  { ip: "127.0.0.2", name: "fresh", last_seen: daysAgo(1) },
  { ip: "127.0.0.3", name: "old-seen-recent-logs", last_seen: daysAgo(60), last_log_received: daysAgo(3) },
  { ip: "127.0.0.4", name: "stale", last_seen: daysAgo(90), last_log_received: daysAgo(80) },
  { ip: "127.0.0.5", name: "never", last_seen: null },
  { ip: "127.0.0.6", name: "multi-a", last_seen: daysAgo(1) },
  { ip: "127.0.0.7", name: "multi-b", last_seen: daysAgo(1) },
];

before(async () => {
  srv = await startServer({ controllers: seeded });
  await srv.sendSyslog([
    "<14>lightinator app: nonce:1 100 hello from sender",
    "<14>lightinator app: nonce:1 200 hello again",
  ]);
});

after(async () => {
  await srv.stop();
});

const api = async (p, init) => {
  const r = await fetch(`${srv.baseUrl}${p}`, init);
  return { status: r.status, body: await r.json() };
};
const post = (p, body) => api(p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const del = (p) => api(p, { method: "DELETE" });
const listControllers = async () => (await api("/api/v1/controllers")).body.items;
const listIps = async () => (await listControllers()).map((c) => c.ip).sort();
const sourceCount = async () => (await api("/api/v1/sources")).body.items.length;

test("seeded controllers are listed and syslog updates lastLogReceived", async () => {
  const items = await listControllers();
  assert.deepEqual(items.map((c) => c.ip).sort(), seeded.map((c) => c.ip).sort());
  const sender = items.find((c) => c.ip === "127.0.0.1");
  assert.ok(sender.lastLogReceived, "lastLogReceived set after UDP ingest");
  assert.equal(await sourceCount(), 1);
});

test("DELETE unknown controller → 404", async () => {
  assert.equal((await del("/api/v1/controllers/10.99.99.99")).status, 404);
});

test("DELETE removes the controller and keeps other logs", async () => {
  const r = await del("/api/v1/controllers/127.0.0.2?purgeLogs=false");
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true, ip: "127.0.0.2", purgedLogs: false });
  assert.ok(!(await listIps()).includes("127.0.0.2"));
  assert.equal(await sourceCount(), 1);
  assert.equal((await del("/api/v1/controllers/127.0.0.2")).status, 404, "second delete is a 404");
});

test("POST /remove removes several controllers and skips unknown ones", async () => {
  const r = await post("/api/v1/controllers/remove", { ips: ["127.0.0.6", "10.1.1.1"], purgeLogs: false });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.removed, ["127.0.0.6"]);
  assert.ok(!(await listIps()).includes("127.0.0.6"));
});

test("remove endpoints validate their body", async () => {
  assert.equal((await post("/api/v1/controllers/remove", { ips: "nope" })).status, 400);
  assert.equal((await post("/api/v1/controllers/remove", { ips: [1] })).status, 400);
  assert.equal((await post("/api/v1/controllers/remove-stale", { days: -1 })).status, 400);
  assert.equal((await post("/api/v1/controllers/remove-stale", { days: "abc" })).status, 400);
});

test("remove-stale with a huge window only removes never-seen controllers", async () => {
  const r = await post("/api/v1/controllers/remove-stale", { days: 100000, purgeLogs: false });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.removed, ["127.0.0.5"]);
  assert.deepEqual(await listIps(), ["127.0.0.1", "127.0.0.3", "127.0.0.4", "127.0.0.7"]);
});

test("remove-stale uses the newer of last_seen / last_log_received", async () => {
  const r = await post("/api/v1/controllers/remove-stale", { days: 30, purgeLogs: false });
  assert.deepEqual(r.body.removed, ["127.0.0.4"]);
  assert.deepEqual(await listIps(), ["127.0.0.1", "127.0.0.3", "127.0.0.7"]);
});

test("DELETE with purgeLogs=true also deletes the controller's logs", async () => {
  const r = await del("/api/v1/controllers/127.0.0.1?purgeLogs=true");
  assert.equal(r.status, 200);
  assert.equal(r.body.purgedLogs, true);
  assert.ok(!(await listIps()).includes("127.0.0.1"));
  assert.equal(await sourceCount(), 0);
});

test("remove-stale with days=0 removes every remaining controller", async () => {
  const r = await post("/api/v1/controllers/remove-stale", { days: 0, purgeLogs: true });
  assert.deepEqual(r.body.removed.sort(), ["127.0.0.3", "127.0.0.7"]);
  assert.deepEqual(await listIps(), []);
});

test("stale auto-purge setting is exposed in the service config and enabled by default", async () => {
  const { body } = await api("/api/v1/service-config");
  const entry = body.schema.find((s) => s.key === "LLS_CONTROLLER_STALE_DAYS");
  assert.ok(entry, "schema entry present");
  assert.equal(entry.type, "number");
  assert.match(entry.description, /logs/);
  assert.equal(body.liveValues.LLS_CONTROLLER_STALE_DAYS, "30");
  assert.match(srv.getOutput(), /Stale purge: controllers not seen for 30 day\(s\) are removed hourly/);
});

test("LLS_CONTROLLER_STALE_DAYS=0 disables the auto-purge job", async () => {
  const off = await startServer({ env: { LLS_CONTROLLER_STALE_DAYS: "0" } });
  try {
    const r = await fetch(`${off.baseUrl}/api/v1/service-config`).then((x) => x.json());
    assert.equal(r.liveValues.LLS_CONTROLLER_STALE_DAYS, "0");
    assert.match(off.getOutput(), /Stale purge: disabled/);
  } finally {
    await off.stop();
  }
});
