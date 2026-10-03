const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { initializeServiceData } = require("../src/startupWorker");
const { openDatabase } = require("../src/db");

test("startup migrations run off the main event loop and restore persisted state", async context => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "lls-startup-worker-"));
  context.after(() => fs.rm(temp, { recursive: true, force: true }));
  const dataDir = path.join(temp, "logs");
  await fs.mkdir(dataDir);
  const dbPath = path.join(temp, "db.sqlite");
  const controllerStatePath = path.join(temp, "controllers.json");
  const records = Array.from({ length: 10000 }, (_, index) => JSON.stringify({ sourceIp: "192.0.2.1", message: `legacy ${index}`, boot: 2, bootNonce: 55 }));
  await fs.writeFile(path.join(dataDir, "192.0.2.1.ndjson"), records.join("\n"));
  await fs.writeFile(controllerStatePath, JSON.stringify([{ ip: "192.0.2.1", name: "legacy", loggingEnabled: false, soc: "esp8266" }]));
  let ticks = 0;
  const timer = setInterval(() => { ticks++; }, 2);
  let state;
  try {
    state = await initializeServiceData({ dbPath, dataDir, controllerStatePath, maxRowsPerIp: 10000 });
  } finally { clearInterval(timer); }
  assert.ok(ticks > 1, "Main-thread timers must run while migrations execute");
  assert.deepEqual(state.boots, [{ ip: "192.0.2.1", boot: 2, nonce: 55 }]);
  assert.equal(state.controllers[0].loggingEnabled, false);
  const db = openDatabase(dbPath);
  try { assert.equal(db.prepare("SELECT COUNT(*) AS count FROM logs").get().count, 10000); }
  finally { db.close(); }
  const repeated = await initializeServiceData({ dbPath, dataDir, controllerStatePath });
  assert.deepEqual(repeated.boots, state.boots);
});

test("startup worker failures reject instead of hanging readiness", async context => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "lls-startup-error-"));
  context.after(() => fs.rm(temp, { recursive: true, force: true }));
  const invalidParent = path.join(temp, "file");
  await fs.writeFile(invalidParent, "not a directory");
  await assert.rejects(initializeServiceData({ dbPath: path.join(invalidParent, "db.sqlite"), dataDir: temp }));
  await assert.rejects(initializeServiceData({ dbPath: ":memory:" }), /file-backed database/);
});