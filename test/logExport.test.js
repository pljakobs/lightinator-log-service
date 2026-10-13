const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const os = require("os");
const path = require("path");
const fs = require("fs");
const { openDatabase } = require("../src/db");
const { LogStorage } = require("../src/storage");
const { resolveLogExport, renderLogExport } = require("../src/logExport");
const { BootTracker } = require("../src/bootTracker");
const { startServer, bootLines } = require("./e2e/server");

const ip = "10.0.0.1";
const t0 = Date.parse("2026-01-01T00:00:00.000Z");
const at = (minute) => new Date(t0 + minute * 60_000).toISOString();
let db, storage, tmpDir, crashId;

// boot 1: minutes 0-4, boot 2: minutes 10-19 (crash at 19), boot 3: minutes 30-32
before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lls-export-"));
  db = openDatabase(path.join(tmpDir, "test.sqlite"));
  storage = new LogStorage({ db, dataDir: path.join(tmpDir, "nope"), maxRowsPerIp: 1000 });
  const add = (minute, boot, message, extra = {}) =>
    storage.append(ip, { receivedAt: at(minute), boot, bootNonce: boot * 11, deviceTime: minute * 1000, tag: "host", app: "app", message, ...extra });
  for (let m = 0; m < 5; m++) await add(m, 1, `b1 m${m}`);
  for (let m = 10; m < 19; m++) await add(m, 2, `b2 m${m}`);
  crashId = await add(19, 2, "\x1b[31mFatal exception 28\x1b[0m", { crashDecode: "\x1b[1mPC: foo() at bar.cpp:12\x1b[0m", gitVersion: "V5.1.0" });
  for (let m = 30; m < 33; m++) await add(m, 3, `b3 m${m}`);
  await storage.append("10.0.0.2", { receivedAt: at(31), boot: 1, message: "other controller" });
});

after(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const render = (query, opts) => [...renderLogExport(storage, resolveLogExport(storage, query, opts))].join("");
const messages = (text) => text.split("\n").filter((l) => l.startsWith("20")).map((l) => l.split(": ").slice(1).join(": "));

test("full export contains every row of the controller with boot markers", () => {
  const text = render({ ip, scope: "all" });
  assert.equal(messages(text).length, 18);
  assert.ok(!text.includes("other controller"));
  assert.deepEqual(text.match(/^---- boot \d+ ----$/gm), ["---- boot 1 ----", "---- boot 2 ----", "---- boot 3 ----"]);
  assert.ok(text.includes(`${at(0)} [${"0".padStart(10)}] host app: b1 m0\n`));
});

test("boot, current and previous scopes select one uptime", () => {
  assert.deepEqual(messages(render({ ip, scope: "boot", boot: "1" })), ["b1 m0", "b1 m1", "b1 m2", "b1 m3", "b1 m4"]);
  assert.deepEqual(messages(render({ ip, scope: "current" })), ["b3 m30", "b3 m31", "b3 m32"]);
  const previous = messages(render({ ip, scope: "previous" }));
  assert.equal(previous.length, 10);
  assert.equal(previous[0], "b2 m10");
});

test("range scope is inclusive and accepts open ends", () => {
  assert.deepEqual(messages(render({ ip, scope: "range", start: at(3), end: at(11) })), ["b1 m3", "b1 m4", "b2 m10", "b2 m11"]);
  assert.deepEqual(messages(render({ ip, scope: "range", start: at(31) })), ["b3 m31", "b3 m32"]);
});

test("crash scope spans N minutes up to the end of the crashed boot and appends the decode", () => {
  const exp = resolveLogExport(storage, { scope: "crash", id: String(crashId), minutes: "3" });
  assert.equal(exp.ip, ip);
  assert.equal(exp.filename, `10.0.0.1_crash-${crashId}.log`);
  const text = [...renderLogExport(storage, exp)].join("");
  assert.deepEqual(messages(text), ["b2 m16", "b2 m17", "b2 m18", "Fatal exception 28"]);
  assert.match(text, /==== Decoded crash \(log id \d+, received .*, boot 2\) ====\nBuild: firmware V5\.1\.0\n\nPC: foo\(\) at bar\.cpp:12\n$/);
  assert.ok(!text.includes("\x1b"));
});

test("crash scope falls back to the configured default span", () => {
  assert.equal(messages(render({ scope: "crash", id: String(crashId) }, { crashMinutes: 1 })).length, 2);
});

test("invalid requests are rejected with a status", () => {
  const status = (query) => { try { resolveLogExport(storage, query); } catch (e) { return e.status; } return 200; };
  assert.equal(status({ scope: "all" }), 400);
  assert.equal(status({ ip, scope: "bogus" }), 400);
  assert.equal(status({ ip, scope: "boot", boot: "x" }), 400);
  assert.equal(status({ ip, scope: "boot", boot: "9" }), 404);
  assert.equal(status({ ip: "10.0.0.2", scope: "previous" }), 404);
  assert.equal(status({ ip, scope: "range" }), 400);
  assert.equal(status({ ip, scope: "range", start: at(5), end: at(1) }), 400);
  assert.equal(status({ scope: "crash", id: "1" }), 404);
  assert.equal(status({ scope: "crash", id: String(crashId), minutes: "-1" }), 400);
});

test("boot export includes records on both sides of a timestamp rollover", async () => {
  const tracker = new BootTracker();
  const rolloverIp = "10.0.0.3";
  const lines = [
    { deviceTime: 2 ** 32 - 3_000_000, receivedAt: at(100), bootNonce: 5, tag: "h", message: "before rollover" },
    { deviceTime: 1_000_000, receivedAt: new Date(Date.parse(at(100)) + 4000).toISOString(), bootNonce: 5, tag: "h", message: "after rollover" },
  ];
  for (const record of lines) {
    tracker.assign(rolloverIp, record);
    await storage.append(rolloverIp, record);
  }
  assert.deepEqual(messages(render({ ip: rolloverIp, scope: "current" })), ["before rollover", "after rollover"]);
});

test("GET /api/v1/logs/download serves a text attachment", async () => {
  const srv = await startServer();
  try {
    await srv.sendSyslog(bootLines([101, 202], 3));
    const r = await fetch(`${srv.baseUrl}/api/v1/logs/download?ip=127.0.0.1&scope=previous`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type"), /^text\/plain/);
    assert.match(r.headers.get("content-disposition"), /^attachment; filename="127\.0\.0\.1_boot-\d+\.log"$/);
    const text = await r.text();
    assert.equal((text.match(/nonce 101 message/g) || []).length, 3);
    assert.ok(!text.includes("nonce 202"));

    const bad = await fetch(`${srv.baseUrl}/api/v1/logs/download?scope=all`);
    assert.equal(bad.status, 400);
  } finally {
    await srv.stop();
  }
});
