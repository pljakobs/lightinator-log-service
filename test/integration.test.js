// Integration: real server process, UDP ingest, HTTP API.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startServer, bootLines } = require("./e2e/server");

let srv;
const ip = "127.0.0.1";

before(async () => {
  srv = await startServer();
  await srv.sendSyslog(bootLines([111, 222, 333], 5));
});

after(async () => {
  await srv.stop();
});

const api = (p) => fetch(`${srv.baseUrl}${p}`).then(async (r) => {
  if (!r.ok) throw new Error(`${p} -> HTTP ${r.status}`);
  return r.json();
});

test("health reports ok", async () => {
  const h = await api("/health");
  assert.equal(h.status, "ok");
});

test("source appears after UDP ingest", async () => {
  const { items } = await api("/api/v1/sources");
  assert.equal(items.length, 1);
  assert.equal(items[0].ip, ip);
  assert.equal(items[0].entries, 15);
});

test("boots are detected from per-line nonces", async () => {
  const { items } = await api(`/api/v1/boots?ip=${ip}`);
  assert.deepEqual(items.map((b) => [b.boot, b.entries]), [[3, 5], [2, 5], [1, 5]]);
});

test("late packet from an earlier boot does not create a new boot", async () => {
  await srv.sendSyslog([`<14>lightinator app: nonce:222 9999 straggler`]);
  const { items } = await api(`/api/v1/boots?ip=${ip}`);
  assert.equal(items.length, 3);
  assert.equal(items.find((b) => b.boot === 2).entries, 6);
});

test("logs paging flags boot starts and exposes cursors", async () => {
  const tail = await api(`/api/v1/logs?ip=${ip}&limit=4`);
  assert.equal(tail.items.length, 4);
  assert.equal(tail.nextAfter, null);
  assert.ok(tail.nextBefore);
  // straggler (id 16, boot 2) sits at the end: 13,14,15 are boot 3, 16 is boot 2
  const starts = tail.items.filter((r) => r.bootStart).map((r) => r.boot);
  assert.deepEqual(starts, [2]);

  const boots = await api(`/api/v1/boots?ip=${ip}`);
  const boot2 = boots.items.find((b) => b.boot === 2);
  const from = await api(`/api/v1/logs?ip=${ip}&from=${boot2.firstId}&limit=3`);
  assert.equal(from.items[0].id, boot2.firstId);
  assert.equal(from.items[0].bootStart, true);
  assert.equal(from.nextBefore, boot2.firstId);
  assert.equal(from.nextAfter, boot2.firstId + 3);
});

test("boot-jump resolves neighbouring boot starts", async () => {
  const boots = (await api(`/api/v1/boots?ip=${ip}`)).items;
  const b2 = boots.find((b) => b.boot === 2);
  const b3 = boots.find((b) => b.boot === 3);
  const prev = await api(`/api/v1/logs/boot-jump?ip=${ip}&currentId=${b3.firstId}&direction=prev`);
  assert.equal(prev.targetId, b2.firstId);
  const next = await api(`/api/v1/logs/boot-jump?ip=${ip}&currentId=${b2.firstId}&direction=next`);
  assert.equal(next.targetId, b3.firstId);
});

test("UI assets are served", async () => {
for (const p of ["/", "/styles.css", "/js/app.js", "/js/logs.js", "/js/changelog.js", "/js/crashes.js"]) {
    const r = await fetch(`${srv.baseUrl}${p}`);
    assert.equal(r.status, 200, p);
  }
});

test("crashes endpoint is empty on a fresh server", async () => {
  const res = await api("/api/v1/crashes?limit=10");
  assert.deepEqual(res, { items: [], total: 0 });
  const filtered = await api(`/api/v1/crashes?ip=${ip}`);
  assert.deepEqual(filtered, { items: [], total: 0 });
});
test("changelog endpoint returns build info and a builds array", async () => {
  const data = await api("/api/v1/changelog");
  assert.ok(data.buildNumber);
  assert.ok(data.gitVersion);
  assert.ok(Array.isArray(data.builds));
  for (const b of data.builds) {
    assert.equal(typeof b.build, "string");
    assert.ok(Array.isArray(b.commits));
  }
});
