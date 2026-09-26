const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const fs = require("fs");
const { openDatabase } = require("../src/db");

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