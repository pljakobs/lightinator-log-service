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
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      ip          TEXT    NOT NULL,
      received_at TEXT    NOT NULL,
      source_ip   TEXT,
      priority    INTEGER,
      tag         TEXT,
      app         TEXT,
      message     TEXT,
      boot        INTEGER,
      boot_nonce  INTEGER,
      device_time INTEGER,
      raw         TEXT
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
      git_version       TEXT
    );
  `);

  // Migrate existing databases that pre-date the `boot` column.
  const cols = db.pragma("table_info(logs)").map((c) => c.name);
  if (!cols.includes("boot")) {
    db.exec("ALTER TABLE logs ADD COLUMN boot INTEGER");
  }

  return db;
}

module.exports = { openDatabase };
