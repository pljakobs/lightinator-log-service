/**
 * db.js
 *
 * Opens (or creates) the application SQLite database and ensures the schema
 * is up to date.  Single module-level function; the caller owns the returned
 * connection and should not close it during normal operation.
 *
 * Tables
 * ──────
 * logs         – one row per syslog record (replaces per-IP .ndjson files)
 * controllers  – one row per discovered controller (replaces controllers.json)
 */

const Database = require("better-sqlite3");
const fs = require("fs");
const path = require("path");

function logTextBytes(prefix = "") {
  return ["message", "raw", "crash_decode", "crash_raw"]
    .map(column => `COALESCE(length(CAST(${prefix}${column} AS BLOB)), 0)`).join(" + ");
}

/**
 * Open the application database, running DDL if this is a fresh file.
 *
 * @param {string} dbPath  Absolute path to the .sqlite file.
 * @returns {import('better-sqlite3').Database}
 */
function openDatabase(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS logs (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      ip           TEXT    NOT NULL,
      received_at  TEXT    NOT NULL,
      source_ip    TEXT,
      priority     INTEGER,
      tag          TEXT,
      app          TEXT,
      message      TEXT,
      boot         INTEGER,
      boot_nonce   INTEGER,
      device_time  INTEGER,
      raw          TEXT,
      crash_raw    TEXT,
      crash_decode TEXT,
      git_version  TEXT,
      sming_version TEXT,
      soc          TEXT,
      build_type   TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_logs_ip_id ON logs (ip, id);

    CREATE TABLE IF NOT EXISTS controllers (
      ip                TEXT PRIMARY KEY,
      hostname          TEXT,
      device_id         TEXT,
      name              TEXT,
      groups            TEXT    NOT NULL DEFAULT '[]',
      logging_enabled   INTEGER NOT NULL DEFAULT 1,
      reachable         INTEGER NOT NULL DEFAULT 0,
      split_brain       INTEGER NOT NULL DEFAULT 0,
      last_seen         TEXT,
      last_log_received TEXT,
      soc               TEXT,
      build_type        TEXT,
      git_version       TEXT,
      sming_version     TEXT,
      boot_nonce        INTEGER
    );

    CREATE TABLE IF NOT EXISTS controller_boot_info (
      ip           TEXT    NOT NULL,
      boot         INTEGER NOT NULL,
      boot_nonce   INTEGER,
      soc          TEXT,
      build_type   TEXT,
      git_version  TEXT,
      sming_version TEXT,
      updated_at   TEXT    NOT NULL,
      PRIMARY KEY (ip, boot)
    );
    
    CREATE TABLE IF NOT EXISTS crash_reports (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      fingerprint  TEXT    NOT NULL UNIQUE,
      log_id       INTEGER NOT NULL,
      issue_url    TEXT    NOT NULL,
      issue_number INTEGER NOT NULL,
      soc          TEXT,
      git_version  TEXT,
      created_at   TEXT    NOT NULL,
      FOREIGN KEY (log_id) REFERENCES logs (id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_crash_reports_fingerprint ON crash_reports (fingerprint);
  `);

  // Migrate existing databases that pre-date newer columns.
  const cols = db.pragma("table_info(logs)").map((c) => c.name);
  if (!cols.includes("boot")) {
    db.exec("ALTER TABLE logs ADD COLUMN boot INTEGER");
  }
  for (const [column, type] of Object.entries({ boot_nonce: "INTEGER", device_time: "INTEGER", crash_raw: "TEXT", sming_version: "TEXT" })) {
    if (!cols.includes(column)) db.exec(`ALTER TABLE logs ADD COLUMN ${column} ${type}`);
  }
  if (!cols.includes("crash_decode")) {
    db.exec("ALTER TABLE logs ADD COLUMN crash_decode TEXT");
  }
  if (!cols.includes("git_version")) {
    db.exec("ALTER TABLE logs ADD COLUMN git_version TEXT");
  }
  if (!cols.includes("soc")) {
    db.exec("ALTER TABLE logs ADD COLUMN soc TEXT");
  }
  if (!cols.includes("build_type")) {
    db.exec("ALTER TABLE logs ADD COLUMN build_type TEXT");
  }

  const controllerCols = db.pragma("table_info(controllers)").map(column => column.name);
  const controllerFields = {
    hostname: "TEXT", device_id: "TEXT", name: "TEXT", groups: "TEXT NOT NULL DEFAULT '[]'",
    logging_enabled: "INTEGER NOT NULL DEFAULT 1", reachable: "INTEGER NOT NULL DEFAULT 0",
    split_brain: "INTEGER NOT NULL DEFAULT 0", last_seen: "TEXT", last_log_received: "TEXT",
    soc: "TEXT", build_type: "TEXT", git_version: "TEXT", sming_version: "TEXT", boot_nonce: "INTEGER",
  };
  for (const [column, type] of Object.entries(controllerFields)) {
    if (!controllerCols.includes(column)) db.exec(`ALTER TABLE controllers ADD COLUMN ${column} ${type}`);
  }

  db.exec("CREATE INDEX IF NOT EXISTS idx_logs_ip_boot ON logs (ip, boot)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_logs_received_at ON logs (received_at)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_logs_ip_received_at ON logs (ip, received_at)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_logs_crash ON logs (crash_decode) WHERE crash_decode IS NOT NULL");

  db.transaction(() => {
    const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'log_usage'").get();
    db.exec(`CREATE TABLE IF NOT EXISTS log_usage (
      ip TEXT PRIMARY KEY, row_count INTEGER NOT NULL, text_bytes INTEGER NOT NULL
    )`);
    if (!exists) db.exec(`INSERT INTO log_usage (ip, row_count, text_bytes)
      SELECT ip, COUNT(*), SUM(${logTextBytes()}) FROM logs GROUP BY ip`);
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS logs_usage_insert AFTER INSERT ON logs BEGIN
        INSERT INTO log_usage (ip, row_count, text_bytes) VALUES (NEW.ip, 1, ${logTextBytes("NEW.")})
        ON CONFLICT(ip) DO UPDATE SET row_count = row_count + 1, text_bytes = text_bytes + excluded.text_bytes;
      END;
      CREATE TRIGGER IF NOT EXISTS logs_usage_delete AFTER DELETE ON logs BEGIN
        UPDATE log_usage SET row_count = row_count - 1, text_bytes = text_bytes - (${logTextBytes("OLD.")}) WHERE ip = OLD.ip;
        DELETE FROM log_usage WHERE ip = OLD.ip AND row_count = 0;
      END;
      CREATE TRIGGER IF NOT EXISTS logs_usage_update AFTER UPDATE ON logs BEGIN
        UPDATE log_usage SET row_count = row_count - 1, text_bytes = text_bytes - (${logTextBytes("OLD.")}) WHERE ip = OLD.ip;
        INSERT INTO log_usage (ip, row_count, text_bytes) VALUES (NEW.ip, 1, ${logTextBytes("NEW.")})
        ON CONFLICT(ip) DO UPDATE SET row_count = row_count + 1, text_bytes = text_bytes + excluded.text_bytes;
        DELETE FROM log_usage WHERE ip = OLD.ip AND row_count = 0;
      END;
    `);
  }).immediate();

  return db;
}

module.exports = { openDatabase, logTextBytes };