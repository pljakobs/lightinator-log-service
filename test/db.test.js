const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const fs = require("fs");
const { openDatabase } = require("../src/db");
const Database = require("better-sqlite3");
const os = require("os");
const { LogStorage } = require("../src/storage");
const { ControllerDiscovery } = require("../src/discovery");

test("Database schema includes all required tables and columns", async (t) => {
  const tmpDbPath = path.join(__dirname, "temp_test.sqlite");
  if (fs.existsSync(tmpDbPath)) fs.unlinkSync(tmpDbPath);

  const db = openDatabase(tmpDbPath);

  try {
    // Verify tables exist
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
    assert.ok(tables.includes("logs"), "Missing 'logs' table");
    assert.ok(tables.includes("controllers"), "Missing 'controllers' table");
    assert.ok(tables.includes("crash_reports"), "Missing 'crash_reports' table");

    // Verify logs columns including metadata fields
    const logColumns = db.pragma("table_info(logs)").map(c => c.name);
    const expectedLogCols = [
      "id", "ip", "received_at", "source_ip", "priority", 
      "tag", "app", "message", "boot", "boot_nonce", 
      "device_time", "raw", "crash_decode", "git_version", "soc", "build_type"
    ];

    for (const col of expectedLogCols) {
      assert.ok(logColumns.includes(col), `Logs table is missing expected column: ${col}`);
    }
  } finally {
    db.close();
    if (fs.existsSync(tmpDbPath)) fs.unlinkSync(tmpDbPath);
  }
});

test("historical SQLite schemas migrate without losing logs or controller state", async context => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "lls-schema-"));
  context.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const dbPath = path.join(temp, "old.sqlite");
  const original = new Database(dbPath);
  original.exec(`
    CREATE TABLE logs (id INTEGER PRIMARY KEY AUTOINCREMENT, ip TEXT NOT NULL, received_at TEXT NOT NULL,
      source_ip TEXT, priority INTEGER, tag TEXT, app TEXT, message TEXT, raw TEXT);
    INSERT INTO logs (ip, received_at, message) VALUES ('192.0.2.1', '2026-01-01T00:00:00Z', 'old log');
    CREATE TABLE controllers (ip TEXT PRIMARY KEY, name TEXT, logging_enabled INTEGER NOT NULL DEFAULT 1);
    INSERT INTO controllers (ip, name, logging_enabled) VALUES ('192.0.2.1', 'old controller', 0);
  `);
  original.close();
  let db = openDatabase(dbPath);
  try {
    const storage = new LogStorage({ db, dataDir: temp });
    await storage.append("192.0.2.1", { message: "new log", bootNonce: 123, deviceTime: 456 });
    const rows = (await storage.getLogs({ ip: "192.0.2.1" })).items;
    assert.strictEqual(rows[0].message, "old log");
    assert.strictEqual(rows[1].bootNonce, 123);
    assert.strictEqual(rows[1].deviceTime, 456);
    const discovery = new ControllerDiscovery({ db, seedHosts: [] });
    await discovery._loadState();
    assert.strictEqual(discovery.controllers.get("192.0.2.1").loggingEnabled, false);
    await discovery._saveState();
    db.close();
    db = openDatabase(dbPath);
    assert.strictEqual(db.prepare("SELECT COUNT(*) AS count FROM logs").get().count, 2);
    assert.ok(db.pragma("table_info(logs)").some(column => column.name === "crash_raw"));
  } finally {
    db.close();
  }
});