// Unit: ControllerDiscovery persistence helpers (remove / listStale) on a temp SQLite DB.
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const os = require("os");
const path = require("path");
const fs = require("fs");
const { openDatabase } = require("../src/db");
const { ControllerDiscovery } = require("../src/discovery");

let db, tmpDir, discovery;

const daysAgo = (d) => new Date(Date.now() - d * 86_400_000).toISOString();
const dbIps = () => db.prepare("SELECT ip FROM controllers ORDER BY ip").all().map((r) => r.ip);

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lls-disc-"));
  db = openDatabase(path.join(tmpDir, "test.sqlite"));
});

after(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(async () => {
  db.prepare("DELETE FROM controllers").run();
  discovery = new ControllerDiscovery({ seedHosts: [], refreshIntervalMs: 0, db });
  discovery.controllers.set("10.0.0.1", { ip: "10.0.0.1", lastSeen: daysAgo(1), lastLogReceived: null });
  discovery.controllers.set("10.0.0.2", { ip: "10.0.0.2", lastSeen: daysAgo(40), lastLogReceived: daysAgo(2) });
  discovery.controllers.set("10.0.0.3", { ip: "10.0.0.3", lastSeen: daysAgo(45), lastLogReceived: daysAgo(35) });
  discovery.controllers.set("10.0.0.4", { ip: "10.0.0.4", lastSeen: null, lastLogReceived: null });
  await discovery._saveState();
  assert.deepEqual(dbIps(), ["10.0.0.1", "10.0.0.2", "10.0.0.3", "10.0.0.4"]);
});

test("remove deletes from memory and DB and reports unknown IPs", () => {
  assert.equal(discovery.remove("10.0.0.1"), true);
  assert.equal(discovery.controllers.has("10.0.0.1"), false);
  assert.deepEqual(dbIps(), ["10.0.0.2", "10.0.0.3", "10.0.0.4"]);
  assert.equal(discovery.remove("10.0.0.1"), false);
  assert.equal(discovery.remove("192.168.1.1"), false);
});

test("remove forgets pending syslog-only seeds", () => {
  discovery.extraSeeds.add("10.9.9.9");
  assert.equal(discovery.remove("10.9.9.9"), false);
  assert.equal(discovery.extraSeeds.has("10.9.9.9"), false);
});

test("removed controllers stay removed after a state save", async () => {
  discovery.remove("10.0.0.2");
  await discovery._saveState();
  assert.deepEqual(dbIps(), ["10.0.0.1", "10.0.0.3", "10.0.0.4"]);
});

test("listStale uses the newer of lastSeen / lastLogReceived and treats null as never", () => {
  assert.deepEqual(discovery.listStale(30).sort(), ["10.0.0.3", "10.0.0.4"]);
  assert.deepEqual(discovery.listStale(1.5).sort(), ["10.0.0.2", "10.0.0.3", "10.0.0.4"]);
  assert.deepEqual(discovery.listStale(1000), ["10.0.0.4"]);
  assert.deepEqual(discovery.listStale(0).sort(), ["10.0.0.1", "10.0.0.2", "10.0.0.3", "10.0.0.4"]);
});

test("persisted rows are reloaded and stale selection survives a restart", async () => {
  const fresh = new ControllerDiscovery({ seedHosts: [], refreshIntervalMs: 0, db });
  await fresh._loadState();
  assert.equal(fresh.controllers.size, 4);
  assert.deepEqual(fresh.listStale(30).sort(), ["10.0.0.3", "10.0.0.4"]);
});
