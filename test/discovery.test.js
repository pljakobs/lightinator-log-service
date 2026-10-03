// Unit: ControllerDiscovery persistence helpers (remove / listStale) on a temp SQLite DB.
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const os = require("os");
const path = require("path");
const fs = require("fs");
const http = require("http");
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

test("HTTP discovery requests the configured port and paths and stores controller metadata", async context => {
  const requests = [];
  const responses = {
    "/hosts?all=true": { hosts: [{ ip_address: "127.0.0.1", hostname: "fixture", id: 1 }] },
    "/data": { controllers: [{ id: "device", name: "Fixture controller", "ip-address": "127.0.0.1" }], groups: [{ id: 2, name: "Fixture group", controller_ids: ["device"] }] },
    "/config": { network: { rsyslog: { enabled: false } } },
    "/info?v=2": { device: { soc: "esp8266" }, app: { git_version: "V1.0.0-1-develop", build_type: "debug" } },
  };
  const server = http.createServer((request, response) => {
    requests.push(request.url);
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify(responses[request.url] || {}));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise(resolve => server.close(resolve)));
  const networkDiscovery = new ControllerDiscovery({ seedHosts: ["127.0.0.1"], controllerPort: server.address().port, refreshIntervalMs: 0 });
  await networkDiscovery.refresh();
  assert.deepEqual(requests.sort(), Object.keys(responses).sort());
  const controller = networkDiscovery.controllers.get("127.0.0.1");
  assert.equal(controller.reachable, true);
  assert.equal(controller.name, "Fixture controller");
  assert.equal(controller.loggingEnabled, false);
  assert.equal(controller.soc, "esp8266");
  assert.equal(controller.gitVersion, "V1.0.0-1-develop");
  assert.deepEqual(controller.groups, [{ id: 2, name: "Fixture group" }]);
});
