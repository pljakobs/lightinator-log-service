const fs = require("fs/promises");
const path = require("path");

/**
 * Map a SQLite logs row (snake_case columns) back to the record shape the
 * rest of the application expects (camelCase).
 */
function rowToRecord(row) {
  return {
    id:          row.id,
    receivedAt:  row.received_at,
    sourceIp:    row.source_ip,
    priority:    row.priority,
    tag:         row.tag,
    app:         row.app,
    message:     row.message,
    boot:        row.boot        != null ? row.boot        : undefined,
    bootNonce:   row.boot_nonce  != null ? row.boot_nonce  : undefined,
    deviceTime:  row.device_time != null ? row.device_time : undefined,
    raw:         row.raw,
  };
}

class LogStorage {
  /**
   * @param {object} opts
   * @param {import('better-sqlite3').Database} opts.db
   * @param {string} opts.dataDir      Legacy NDJSON directory — used only once for migration.
   * @param {number} opts.maxRowsPerIp Max rows kept per IP (oldest trimmed on insert).
   */
  constructor({ db, dataDir, maxRowsPerIp = 10_000 }) {
    this.db = db;
    this.dataDir = dataDir;
    this.maxRowsPerIp = maxRowsPerIp;

    // Pre-compile frequently used statements (better-sqlite3 is synchronous)
    this._stmtInsert = db.prepare(`
      INSERT INTO logs (ip, received_at, source_ip, priority, tag, app, message, boot, boot_nonce, device_time, raw)
      VALUES (@ip, @received_at, @source_ip, @priority, @tag, @app, @message, @boot, @boot_nonce, @device_time, @raw)
    `);
    this._stmtTrimCheck = db.prepare(
      "SELECT COUNT(*) AS cnt FROM logs WHERE ip = ?",
    );
    this._stmtTrim = db.prepare(`
      DELETE FROM logs WHERE ip = ? AND id < (
        SELECT id FROM logs WHERE ip = ? ORDER BY id DESC LIMIT 1 OFFSET ?
      )
    `);
    this._stmtLastBoot = db.prepare(
      "SELECT boot FROM logs WHERE ip = ? AND boot IS NOT NULL ORDER BY id DESC LIMIT 1",
    );
    this._stmtSources = db.prepare(`
      SELECT ip, MAX(received_at) AS last_seen, COUNT(*) AS entries
      FROM logs
      GROUP BY ip
      ORDER BY last_seen DESC
    `);
    this._stmtLogs = db.prepare(`
      SELECT * FROM logs
      WHERE ip = ? AND (? = 0 OR id < ?)
      ORDER BY id DESC
      LIMIT ?
    `);
    this._stmtCount = db.prepare("SELECT COUNT(*) AS cnt FROM logs WHERE ip = ?");
    this._stmtPurgeIp  = db.prepare("DELETE FROM logs WHERE ip = ?");
    this._stmtPurgeAll = db.prepare("DELETE FROM logs");
    this._stmtSearch = db.prepare(`
      SELECT id, ip FROM logs
      WHERE message LIKE ? OR tag LIKE ? OR app LIKE ?
      ORDER BY id DESC
      LIMIT ?
    `);
    this._stmtSearchCtx = db.prepare(
      "SELECT * FROM logs WHERE ip = ? AND id BETWEEN ? AND ? ORDER BY id ASC",
    );
  }

  /**
   * One-time migration: import any *.ndjson files found in dataDir into the
   * database, then rename each to *.ndjson.imported so they are not re-read.
   */
  async init() {
    let files;
    try {
      files = await fs.readdir(this.dataDir);
    } catch {
      return; // dataDir doesn't exist yet — nothing to migrate
    }

    const ndjsonFiles = files.filter((f) => f.endsWith(".ndjson"));
    if (ndjsonFiles.length === 0) return;

    console.log(`Storage: migrating ${ndjsonFiles.length} NDJSON file(s) to SQLite…`);

    const insertMany = this.db.transaction((records) => {
      for (const r of records) this._stmtInsert.run(r);
    });

    for (const file of ndjsonFiles) {
      const fullPath = path.join(this.dataDir, file);
      try {
        const content = await fs.readFile(fullPath, "utf8");
        const records = content
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean)
          .map((l) => {
            try { return JSON.parse(l); } catch { return null; }
          })
          .filter(Boolean)
          .map((rec) => ({
            ip:          rec.sourceIp || file.replace(/\.ndjson$/, "").replace(/_/g, ":"),
            received_at: rec.receivedAt  || new Date().toISOString(),
            source_ip:   rec.sourceIp   || null,
            priority:    rec.priority   ?? null,
            tag:         rec.tag        || null,
            app:         rec.app        || null,
            message:     rec.message    || null,
            boot:        rec.boot       ?? null,
            boot_nonce:  rec.bootNonce  ?? null,
            device_time: rec.deviceTime ?? null,
            raw:         rec.raw        || null,
          }));

        insertMany(records);
        await fs.rename(fullPath, fullPath + ".imported");
        console.log(`Storage: migrated ${records.length} record(s) from ${file}`);
      } catch (err) {
        console.warn(`Storage: failed to migrate ${file}: ${err.message}`);
      }
    }
  }

  append(ip, record) {
    this._stmtInsert.run({
      ip,
      received_at: record.receivedAt  || new Date().toISOString(),
      source_ip:   record.sourceIp   || ip,
      priority:    record.priority   ?? null,
      tag:         record.tag        || null,
      app:         record.app        || null,
      message:     record.message    || null,
      boot:        record.boot       ?? null,
      boot_nonce:  record.bootNonce  ?? null,
      device_time: record.deviceTime ?? null,
      raw:         record.raw        || null,
    });

    // Trim to maxRowsPerIp — the sub-SELECT finds the id at position
    // (maxRowsPerIp - 1) from the newest end (0-based OFFSET); all older rows
    // are deleted, leaving exactly maxRowsPerIp rows.
    const { cnt } = this._stmtTrimCheck.get(ip);
    if (cnt > this.maxRowsPerIp) {
      this._stmtTrim.run(ip, ip, this.maxRowsPerIp - 1);
    }

    return Promise.resolve();
  }

  listSources() {
    return this._stmtSources.all().map((row) => ({
      ip:       row.ip,
      entries:  row.entries,
      lastSeen: row.last_seen,
      bytes:    null, // no longer tracked
    }));
  }

  getLogs({ ip, limit = 200, before = 0 }) {
    const safeLimit  = Math.max(1, Math.min(2000, Number.parseInt(limit, 10)  || 200));
    const safeBefore = Math.max(0,               Number.parseInt(before, 10)  || 0);

    // Fetch one extra row to detect whether older records exist
    const rows = this._stmtLogs.all(ip, safeBefore, safeBefore, safeLimit + 1);

    const hasMore = rows.length > safeLimit;
    if (hasMore) rows.pop();

    // rows are newest-first; reverse to chronological order for the UI
    const items = rows.reverse().map(rowToRecord);
    const nextBefore = hasMore ? rows[0].id : null;

    const { cnt: total } = this._stmtCount.get(ip);

    return Promise.resolve({ items, total, before: safeBefore, nextBefore });
  }

  purgeIp(ip) {
    this._stmtPurgeIp.run(ip);
    return Promise.resolve();
  }

  purgeAll() {
    this._stmtPurgeAll.run();
    return Promise.resolve();
  }

  /**
   * Full-text search across all IPs.
   * Returns up to `limit` matching rows (newest first), each with `context`
   * rows of surrounding entries from the same IP.
   *
   * @param {object} opts
   * @param {string} opts.query   Substring to match (case-insensitive via LIKE).
   * @param {number} [opts.limit=50]   Max matching rows to return (1–200).
   * @param {number} [opts.context=3]  Rows of context before/after each match (0–20).
   */
  search({ query, limit = 50, context = 3 }) {
    const safeLimit   = Math.max(1, Math.min(200, Number.parseInt(limit,   10) || 50));
    const safeContext = Math.max(0, Math.min(20,  Number.parseInt(context, 10) || 3));
    const q = `%${query}%`;

    const matches = this._stmtSearch.all(q, q, q, safeLimit);
    if (!matches.length) return { query, snippets: [], total: 0 };

    const matchIdSet = new Set(matches.map((m) => m.id));
    const snippets = matches.map((match) => ({
      ip:      match.ip,
      matchId: match.id,
      rows:    this._stmtSearchCtx
        .all(match.ip, match.id - safeContext, match.id + safeContext)
        .map((r) => ({ ...rowToRecord(r), _match: matchIdSet.has(r.id) })),
    }));

    return { query, snippets, total: matches.length };
  }

  /**
   * Return the most recent `boot` counter stored for an IP from SQLite.
   * Returns 0 if no records exist or no record has a boot value.
   * Called on service startup so the in-memory boot counter resumes correctly.
   */
  lastBootFor(ip) {
    const row = this._stmtLastBoot.get(ip);
    return Promise.resolve(row ? row.boot : 0);
  }
}

module.exports = { LogStorage };
