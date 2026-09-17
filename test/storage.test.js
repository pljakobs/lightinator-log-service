const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const os = require("os");
const path = require("path");
const fs = require("fs");
const { openDatabase } = require("../src/db");
const { LogStorage } = require("../src/storage");

const ip = "10.0.0.1";
let db, storage, tmpDir;

// boot 1 -> ids 1-5, boot 2 -> ids 6-12, boot 3 -> ids 13-20
const bootOf = (i) => (i <= 5 ? 1 : i <= 12 ? 2 : 3);
const nonceOf = (i) => bootOf(i) * 111;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lls-test-"));
  db = openDatabase(path.join(tmpDir, "test.sqlite"));
  storage = new LogStorage({ db, dataDir: path.join(tmpDir, "nope"), maxRowsPerIp: 1000 });
  await storage.init();
  for (let i = 1; i <= 20; i++) {
    await storage.append(ip, { message: `m${i}`, boot: bootOf(i), bootNonce: nonceOf(i) });
  }
});

after(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const ids = (res) => res.items.map((r) => r.id);
const starts = (res) => res.items.filter((r) => r.bootStart).map((r) => r.id);

test("tail window has no bootStart mid-boot", async () => {
  const res = await storage.getLogs({ ip, limit: 6 });
  assert.deepEqual(ids(res), [15, 16, 17, 18, 19, 20]);
  assert.deepEqual(starts(res), []);
  assert.equal(res.nextBefore, 15);
  assert.equal(res.nextAfter, null);
  assert.equal(res.total, 20);
});

test("older window flags the real boot start and exposes newer cursor", async () => {
  const res = await storage.getLogs({ ip, limit: 6, before: 15 });
  assert.deepEqual(ids(res), [9, 10, 11, 12, 13, 14]);
  assert.deepEqual(starts(res), [13]);
  assert.equal(res.nextBefore, 9);
  assert.equal(res.nextAfter, 15);
});

test("from window starts at the requested id", async () => {
  const res = await storage.getLogs({ ip, limit: 4, from: 6 });
  assert.deepEqual(ids(res), [6, 7, 8, 9]);
  assert.deepEqual(starts(res), [6]);
  assert.equal(res.nextBefore, 6);
  assert.equal(res.nextAfter, 10);
});

test("first row of history is a boot start and has no older cursor", async () => {
  const res = await storage.getLogs({ ip, limit: 4, from: 1 });
  assert.deepEqual(starts(res), [1]);
  assert.equal(res.nextBefore, null);
});

test("from window reaching the tail has no newer cursor", async () => {
  const res = await storage.getLogs({ ip, limit: 10, from: 15 });
  assert.deepEqual(ids(res), [15, 16, 17, 18, 19, 20]);
  assert.equal(res.nextAfter, null);
});

test("prev jump from mid-boot goes to start of the current boot", () => {
  assert.deepEqual(storage.getBootJumpTarget(ip, 15, "prev"), { id: 13, boot: 3 });
});

test("prev jump from a boot start goes to the previous boot", () => {
  assert.deepEqual(storage.getBootJumpTarget(ip, 13, "prev"), { id: 6, boot: 2 });
});

test("prev jump from the first row returns null", () => {
  assert.equal(storage.getBootJumpTarget(ip, 1, "prev"), null);
});

test("next jump goes to the following boot start", () => {
  assert.deepEqual(storage.getBootJumpTarget(ip, 3, "next"), { id: 6, boot: 2 });
  assert.deepEqual(storage.getBootJumpTarget(ip, 6, "next"), { id: 13, boot: 3 });
});

test("next jump from the last boot returns null", () => {
  assert.equal(storage.getBootJumpTarget(ip, 20, "next"), null);
});

test("listBoots summarises boot sessions newest first", () => {
  const boots = storage.listBoots(ip);
  assert.deepEqual(boots.map((b) => [b.boot, b.firstId, b.lastId, b.entries]), [
    [3, 13, 20, 8],
    [2, 6, 12, 7],
    [1, 1, 5, 5],
  ]);
  assert.equal(boots[0].crashes, 0);
  assert.ok(boots[0].startedAt);
});

test("lastBootFor / lastBootNonceFor return the newest values", async () => {
  assert.equal(await storage.lastBootFor(ip), 3);
  assert.equal(storage.lastBootNonceFor(ip), 333);
  assert.equal(await storage.lastBootFor("192.0.2.1"), 0);
  assert.equal(storage.lastBootNonceFor("192.0.2.1"), undefined);
});

test("maxRowsPerIp trims oldest rows", async () => {
  const small = new LogStorage({ db, dataDir: tmpDir, maxRowsPerIp: 3 });
  const other = "10.0.0.2";
  for (let i = 0; i < 5; i++) await small.append(other, { message: `x${i}`, boot: 1 });
  const res = await small.getLogs({ ip: other });
  assert.equal(res.items.length, 3);
  assert.deepEqual(res.items.map((r) => r.message), ["x2", "x3", "x4"]);
});

test("listCrashes returns decoded crashes newest first with pending flag and ip filter", async () => {
  const crashIp = "10.0.0.9";
  const longLine = "Exception (28): epc1=0x4000bf80 " + "x".repeat(200);
  const a = await storage.append(crashIp, { message: "crash a", boot: 1, crashDecode: "\n\n\x1b[31mException (0): guru meditation\x1b[0m\nPC: 0x40201234 app_main" });
  const b = await storage.append(ip,      { message: "crash b", boot: 3, crashDecode: longLine + "\nmore" });
  const c = await storage.append(crashIp, { message: "crash c\nsecond line", boot: 2, crashDecode: "[Crash dump detected, decoding in progress...]" });

  const all = storage.listCrashes({ limit: 10 });
  assert.equal(all.total, 3);
  assert.deepEqual(all.items.map((r) => r.id), [c, b, a]);

  const [rc, rb, ra] = all.items;
  assert.equal(rc.pending, true);
  assert.equal(rc.summary, "");
  assert.equal(rc.message, "crash c");
  assert.equal(rc.ip, crashIp);
  assert.equal(rc.boot, 2);
  assert.equal(rc.fingerprint, null);
  assert.equal(rc.issueUrl, null);

  assert.equal(rb.pending, false);
  assert.equal(rb.summary.length, 160);
  assert.ok(rb.summary.endsWith("…"));

  assert.equal(ra.pending, false);
  assert.equal(ra.summary, "Exception (0): guru meditation");
  assert.ok(ra.receivedAt);

  const limited = storage.listCrashes({ limit: 1 });
  assert.equal(limited.items.length, 1);
  assert.equal(limited.total, 3);

  const filtered = storage.listCrashes({ ip: crashIp });
  assert.equal(filtered.total, 2);
  assert.deepEqual(filtered.items.map((r) => r.id), [c, a]);

  // crash_reports join surfaces issue data
  db.prepare(`INSERT INTO crash_reports (fingerprint, log_id, issue_url, issue_number, soc, git_version, created_at)
              VALUES ('fp-a', ?, 'https://github.com/x/y/issues/7', 7, 'esp8266', 'v1.2.3', '2026-01-01T00:00:00Z')`).run(a);
  const joined = storage.listCrashes({ ip: crashIp }).items.find((r) => r.id === a);
  assert.equal(joined.fingerprint, "fp-a");
  assert.equal(joined.issueUrl, "https://github.com/x/y/issues/7");
  assert.equal(joined.issueNumber, 7);
  assert.equal(joined.soc, "esp8266");
  assert.equal(joined.gitVersion, "v1.2.3");
});
