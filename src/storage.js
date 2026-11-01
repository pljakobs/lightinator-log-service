const fs = require("fs/promises");
const path = require("path");
const { logTextBytes } = require("./db");

// Placeholder text written by CrashDecoder while a dump is being decoded.
const CRASH_PENDING_MARKER = "decoding in progress";

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
    crashRaw:    row.crash_raw || null,
    crashDecode: row.crash_decode || null,
    gitVersion:  row.git_version || null,
    smingVersion: row.sming_version || null,
    soc:         row.soc || null,
    buildType:   row.build_type || null,
  };
}

class LogStorage {
  /**
   * @param {object} opts
   * @param {import('better-sqlite3').Database} opts.db
   * @param {string} opts.dataDir      Legacy NDJSON directory — used only once for migration.
   * @param {number} opts.maxRowsPerIp Max rows kept per IP (oldest trimmed on insert).
   */
  constructor({ db, dataDir, maxRowsPerIp = 10_000, retentionDays = 0, maxBytesPerIp = 0,
    crashLogMinutes = 10, crashRetentionDays = 90 }) {
    this.db = db;
    this.dataDir = dataDir;
    this.maxRowsPerIp = maxRowsPerIp;
    this.retentionDays = retentionDays;
    this.maxBytesPerIp = maxBytesPerIp;
    this.crashLogMinutes = crashLogMinutes;
    this.crashRetentionDays = crashRetentionDays;
    this._stmtPruneAge = db.prepare("DELETE FROM logs WHERE received_at < ?");
    this._stmtPruneAgeIp = db.prepare("DELETE FROM logs WHERE ip = ? AND received_at < ?");
    this._stmtUsage = db.prepare("SELECT row_count AS cnt, text_bytes AS bytes FROM log_usage WHERE ip = ?");
    this._stmtOldest = db.prepare(`SELECT id, ${logTextBytes()} AS bytes FROM logs WHERE ip = ? ORDER BY id ASC LIMIT 128`);
    this._stmtDeleteId = db.prepare("DELETE FROM logs WHERE id = ?");
    this._stmtOverBudget = db.prepare("SELECT ip FROM log_usage WHERE text_bytes > ?");

    // Pre-compile frequently used statements (better-sqlite3 is synchronous)
    this._stmtInsert = db.prepare(`
      INSERT INTO logs (ip, received_at, source_ip, priority, tag, app, message, boot, boot_nonce, device_time, raw, crash_decode, crash_raw, git_version, sming_version, soc, build_type)
      VALUES (@ip, @received_at, @source_ip, @priority, @tag, @app, @message, @boot, @boot_nonce, @device_time, @raw, @crash_decode, @crash_raw, @git_version, @sming_version, @soc, @build_type)
    `);
    this._stmtUpdateCrashDecode = db.prepare(`
      UPDATE logs SET crash_decode = ?, git_version = COALESCE(?, git_version), sming_version = COALESCE(?, sming_version),
        soc = COALESCE(?, soc), build_type = COALESCE(?, build_type), crash_raw = COALESCE(?, crash_raw)
      WHERE id = ?
    `);
    this._stmtCrashRow = db.prepare("SELECT * FROM logs WHERE id = ?");
    this._stmtCrashArchiveRow = db.prepare("SELECT * FROM crash_archive WHERE id = ?");
    this._stmtCrashContext = db.prepare(`
      SELECT * FROM logs WHERE ip = ? AND id < ? AND received_at >= ? ORDER BY id ASC
    `);
    this._stmtUpsertCrashArchive = db.prepare(`
      INSERT INTO crash_archive (
        id, log_id, ip, received_at, boot, boot_nonce, device_time, source_ip, priority, tag, app, message,
        crash_raw, crash_decode, git_version, sming_version, soc, build_type, context_logs
      ) VALUES (
        @id, @log_id, @ip, @received_at, @boot, @boot_nonce, @device_time, @source_ip, @priority, @tag, @app, @message,
        @crash_raw, @crash_decode, @git_version, @sming_version, @soc, @build_type, @context_logs
      ) ON CONFLICT(id) DO UPDATE SET
        crash_raw = COALESCE(excluded.crash_raw, crash_archive.crash_raw),
        crash_decode = excluded.crash_decode,
        git_version = COALESCE(excluded.git_version, crash_archive.git_version),
        sming_version = COALESCE(excluded.sming_version, crash_archive.sming_version),
        soc = COALESCE(excluded.soc, crash_archive.soc),
        build_type = COALESCE(excluded.build_type, crash_archive.build_type),
        context_logs = CASE WHEN crash_archive.context_logs = '[]' THEN excluded.context_logs ELSE crash_archive.context_logs END
    `);
    this._stmtUpdateArchivedCrash = db.prepare(`
      UPDATE crash_archive SET crash_decode = ?, crash_raw = COALESCE(?, crash_raw),
        git_version = COALESCE(?, git_version), sming_version = COALESCE(?, sming_version),
        soc = COALESCE(?, soc), build_type = COALESCE(?, build_type)
      WHERE id = ?
    `);
    this._stmtPruneCrashArchive = db.prepare("DELETE FROM crash_archive WHERE received_at < ?");
    this._stmtPruneCrashArchiveIp = db.prepare("DELETE FROM crash_archive WHERE ip = ? AND received_at < ?");
    this._stmtGetCrashDecode = db.prepare(`
      SELECT crash_decode FROM logs WHERE id = ?
    `);
    this._stmtTrimCheck = db.prepare(
      "SELECT row_count AS cnt FROM log_usage WHERE ip = ?",
    );
    this._stmtTrim = db.prepare(`
      DELETE FROM logs WHERE id IN (SELECT id FROM logs WHERE ip = ? ORDER BY id ASC LIMIT ?)
    `);
    this._stmtLastBoot = db.prepare(
      "SELECT MAX(boot) AS boot FROM logs WHERE ip = ? AND boot IS NOT NULL",
    );
    this._stmtLastBootNonce = db.prepare(
      "SELECT boot_nonce FROM logs WHERE ip = ? AND boot = ? AND boot_nonce IS NOT NULL ORDER BY id DESC LIMIT 1",
    );
    this._stmtLastDeviceTime = db.prepare(
      "SELECT device_time, received_at FROM logs WHERE ip = ? AND boot = ? AND device_time IS NOT NULL ORDER BY id DESC LIMIT 1",
    );
    this._stmtSources = db.prepare(`
      SELECT ip, MAX(last_seen) AS last_seen, SUM(entries) AS entries FROM (
        SELECT ip, MAX(received_at) AS last_seen, COUNT(*) AS entries FROM logs GROUP BY ip
        UNION ALL
        SELECT ip, MAX(received_at) AS last_seen, 0 AS entries FROM crash_archive GROUP BY ip
      ) GROUP BY ip
      ORDER BY last_seen DESC
    `);
    this._stmtLogs = db.prepare(`
      SELECT * FROM logs
      WHERE ip = ? AND (? = 0 OR id < ?)
      ORDER BY id DESC
      LIMIT ?
    `);
    this._stmtLogsFrom = db.prepare(`
      SELECT * FROM logs
      WHERE ip = ? AND id >= ?
      ORDER BY id ASC
      LIMIT ?
    `);
    this._stmtRowBefore = db.prepare(
      "SELECT id, boot FROM logs WHERE ip = ? AND id < ? ORDER BY id DESC LIMIT 1",
    );
    this._stmtBootRowBefore = db.prepare(
      "SELECT id, boot FROM logs WHERE ip = ? AND id < ? AND boot IS NOT NULL ORDER BY id DESC LIMIT 1",
    );
    this._stmtBootOfRow = db.prepare("SELECT boot FROM logs WHERE ip = ? AND id = ?");
    this._stmtFirstIdOfBoot = db.prepare("SELECT MIN(id) AS id FROM logs WHERE ip = ? AND boot = ?");
    this._stmtNextBootStart = db.prepare(`
      SELECT MIN(id) AS id FROM logs
      WHERE ip = ? AND id > ? AND boot IS NOT NULL AND (? IS NULL OR boot != ?)
    `);
    this._stmtBoots = db.prepare(`
      SELECT boot,
             MIN(id) AS first_id, MAX(id) AS last_id,
             MIN(received_at) AS started_at, MAX(received_at) AS ended_at,
             COUNT(*) AS entries,
             SUM(CASE WHEN crash_decode IS NOT NULL THEN 1 ELSE 0 END) AS crashes
      FROM logs
      WHERE ip = ? AND boot IS NOT NULL
      GROUP BY boot
      ORDER BY boot DESC
    `);
    this._stmtBootRange = db.prepare(`
      SELECT MIN(id) AS first_id, MAX(id) AS last_id,
             MIN(received_at) AS started_at, MAX(received_at) AS ended_at
      FROM logs WHERE ip = ? AND boot = ?
    `);
    this._stmtExport = db.prepare(`
      SELECT * FROM logs
      WHERE ip = @ip AND id BETWEEN @minId AND @maxId
        AND received_at BETWEEN @since AND @until
        AND (@boot IS NULL OR boot = @boot)
      ORDER BY id ASC
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
    this._stmtCrashes = db.prepare(`
      SELECT a.id, a.ip, a.received_at, a.boot, a.message, a.crash_decode,
             COALESCE(a.fingerprint, c.fingerprint) AS fingerprint,
             COALESCE(a.issue_url, c.issue_url) AS issue_url,
             COALESCE(a.issue_number, c.issue_number) AS issue_number,
             COALESCE(a.soc, c.soc) AS soc,
             COALESCE(a.git_version, c.git_version) AS git_version,
             a.sming_version AS sming_version,
             EXISTS(SELECT 1 FROM logs l WHERE l.id = a.log_id) AS log_available
      FROM crash_archive a
      LEFT JOIN crash_reports c ON c.log_id = a.log_id
      WHERE a.crash_decode IS NOT NULL AND (? IS NULL OR a.ip = ?)
      ORDER BY a.received_at DESC, a.id DESC
      LIMIT ?
    `);
    this._stmtCrashCount = db.prepare(
      "SELECT COUNT(*) AS cnt FROM crash_archive WHERE crash_decode IS NOT NULL AND (? IS NULL OR ip = ?)",
    );

    this._backfillCrashArchive();
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
            crash_decode: rec.crashDecode || null,
            crash_raw:   rec.crashRaw || null,
            git_version: rec.gitVersion || null,
            sming_version: rec.smingVersion || null,
            soc:         rec.soc || null,
            build_type:  rec.buildType || null,
          }));

        insertMany(records);
        await fs.rename(fullPath, fullPath + ".imported");
        console.log(`Storage: migrated ${records.length} record(s) from ${file}`);
      } catch (err) {
        console.warn(`Storage: failed to migrate ${file}: ${err.message}`);
      }
    }
    this._backfillCrashArchive();
  }

  _backfillCrashArchive() {
    const rows = this.db.prepare("SELECT * FROM logs WHERE crash_decode IS NOT NULL ORDER BY id ASC").all();
    for (const row of rows) this._archiveCrashRow(row, row.crash_decode);
  }

  _archiveCrashRow(row, decodedText, metadata = {}) {
    const existing = this._stmtCrashArchiveRow.get(row.id);
    let contextLogs = existing?.context_logs || "[]";
    if (contextLogs === "[]") {
      const cutoff = new Date(Date.parse(row.received_at) - this.crashLogMinutes * 60_000).toISOString();
      contextLogs = JSON.stringify(this._stmtCrashContext.all(row.ip, row.id, cutoff).map(rowToRecord));
    }
    this._stmtUpsertCrashArchive.run({
      id: row.id,
      log_id: row.id,
      ip: row.ip,
      received_at: row.received_at,
      boot: row.boot,
      boot_nonce: row.boot_nonce,
      device_time: row.device_time,
      source_ip: row.source_ip,
      priority: row.priority,
      tag: row.tag,
      app: row.app,
      message: row.message,
      crash_raw: metadata.rawDump ?? row.crash_raw,
      crash_decode: decodedText,
      git_version: metadata.gitVersion ?? row.git_version,
      sming_version: metadata.smingVersion ?? row.sming_version,
      soc: metadata.soc ?? row.soc,
      build_type: metadata.buildType ?? row.build_type,
      context_logs: contextLogs,
    });
  }

  append(ip, record, { deferPrune = false } = {}) {
    const info = this._stmtInsert.run({
      ip,
      received_at:  record.receivedAt  || new Date().toISOString(),
      source_ip:    record.sourceIp   || ip,
      priority:     record.priority   ?? null,
      tag:          record.tag        || null,
      app:          record.app        || null,
      message:      record.message    || null,
      boot:         record.boot       ?? null,
      boot_nonce:   record.bootNonce  ?? null,
      device_time:  record.deviceTime ?? null,
      raw:          record.raw        || null,
      crash_decode: record.crashDecode || null,
      crash_raw:    record.crashRaw || null,
      git_version:  record.gitVersion || null,
      sming_version: record.smingVersion || null,
      soc:          record.soc || null,
      build_type:   record.buildType || null,
    });

    if (info && info.lastInsertRowid) {
      record.id = info.lastInsertRowid;
    }

    if (record.crashDecode && record.id) {
      this.updateCrashDecode(record.id, record.crashDecode, {
        rawDump: record.crashRaw,
        gitVersion: record.gitVersion,
        smingVersion: record.smingVersion,
        soc: record.soc,
        buildType: record.buildType,
      });
    }

    if (!deferPrune) this.prune({ ip });

    return Promise.resolve(record.id);
  }

  updateCrashDecode(logId, decodedText, metadata = {}) {
    this._stmtUpdateCrashDecode.run(decodedText, metadata.gitVersion ?? null, metadata.smingVersion ?? null,
      metadata.soc ?? null, metadata.buildType ?? null, metadata.rawDump ?? null, logId);
    const row = this._stmtCrashRow.get(logId);
    if (row) {
      this._archiveCrashRow(row, decodedText, metadata);
      this.prune({ ip: row.ip });
    } else {
      this._stmtUpdateArchivedCrash.run(decodedText, metadata.rawDump ?? null, metadata.gitVersion ?? null,
        metadata.smingVersion ?? null, metadata.soc ?? null, metadata.buildType ?? null, logId);
    }
    return Promise.resolve();
  }

  getCrashRecord(logId) {
    const row = this._stmtCrashArchiveRow.get(logId) || this.db.prepare(
      "SELECT * FROM logs WHERE id = ? AND crash_decode IS NOT NULL",
    ).get(logId);
    if (!row) return null;
    let contextLogs = [];
    try { contextLogs = JSON.parse(row.context_logs || "[]"); } catch { /* ignore invalid legacy context */ }
    return { ...rowToRecord(row), ip: row.ip, raw: row.crash_raw || null, contextLogs };
  }

  getBootFirmwareInfo(ip, boot, bootNonce) {
    let row = boot != null
      ? this.db.prepare(`SELECT soc, build_type, git_version, sming_version, boot_nonce
        FROM controller_boot_info WHERE ip = ? AND boot = ?`).get(ip, boot)
      : null;
    if (!row && boot != null) {
      row = this.db.prepare(`SELECT soc, build_type, git_version, sming_version, boot_nonce FROM logs
        WHERE ip = ? AND boot = ? AND git_version IS NOT NULL ORDER BY id DESC LIMIT 1`).get(ip, boot);
    }
    if (!row && boot == null && bootNonce != null) {
      row = this.db.prepare(`SELECT soc, build_type, git_version, sming_version, boot_nonce
        FROM controller_boot_info WHERE ip = ? AND boot_nonce = ? ORDER BY boot DESC LIMIT 1`).get(ip, bootNonce);
    }
    if (!row && boot == null && bootNonce != null) {
      row = this.db.prepare(`SELECT soc, build_type, git_version, sming_version, boot_nonce FROM logs
        WHERE ip = ? AND boot_nonce = ? AND git_version IS NOT NULL ORDER BY id DESC LIMIT 1`).get(ip, bootNonce);
    }
    return row || null;
  }

  prune({ ip = null, now = Date.now() } = {}) {
    return this.db.transaction(() => {
      let deleted = 0;
      if (this.retentionDays > 0) {
        const cutoff = new Date(now - this.retentionDays * 86_400_000).toISOString();
        deleted += ip == null ? this._stmtPruneAge.run(cutoff).changes : this._stmtPruneAgeIp.run(ip, cutoff).changes;
      }
      const rowIps = ip == null
        ? this.db.prepare("SELECT ip FROM log_usage WHERE row_count > ?").all(this.maxRowsPerIp).map(row => row.ip)
        : [ip];
      for (const source of rowIps) {
        const { cnt } = this._stmtTrimCheck.get(source);
        if (cnt > this.maxRowsPerIp) deleted += this._stmtTrim.run(source, cnt - this.maxRowsPerIp).changes;
      }
      if (this.crashRetentionDays > 0) {
        const crashCutoff = new Date(now - this.crashRetentionDays * 86_400_000).toISOString();
        deleted += ip == null ? this._stmtPruneCrashArchive.run(crashCutoff).changes
          : this._stmtPruneCrashArchiveIp.run(ip, crashCutoff).changes;
      }
      if (this.maxBytesPerIp > 0) {
        const sources = ip == null ? this._stmtOverBudget.all(this.maxBytesPerIp).map(source => source.ip) : [ip];
        for (const source of sources) {
          let bytes = this._stmtUsage.get(source)?.bytes || 0;
          while (bytes > this.maxBytesPerIp) {
            const oldest = this._stmtOldest.all(source);
            if (!oldest.length) break;
            for (const row of oldest) {
              if (bytes <= this.maxBytesPerIp) break;
              deleted += this._stmtDeleteId.run(row.id).changes;
              bytes -= row.bytes;
            }
          }
        }
      }
      return deleted;
    })();
  }

  getCrashDecode(logId) {
    const row = this._stmtCrashArchiveRow.get(logId) || this._stmtGetCrashDecode.get(logId);
    return Promise.resolve(row ? row.crash_decode : null);
  }

  listSources() {
    return this._stmtSources.all().map((row) => ({
      ip:       row.ip,
      entries:  row.entries,
      lastSeen: row.last_seen,
      bytes:    null, // no longer tracked
    }));
  }

  /**
   * Page through logs of one IP in chronological order.
   *  - `before`: window of the newest `limit` rows with id < before (0 = tail)
   *  - `from`:   window of `limit` rows with id >= from (takes precedence)
   * `nextBefore` / `nextAfter` are the cursor values to pass for older / newer
   * rows (null = none). Every item carries `bootStart` = true when its boot
   * differs from the row immediately preceding it in the database.
   */
  getLogs({ ip, limit = 200, before = 0, from = 0 }) {
    const safeLimit  = Math.max(1, Math.min(2000, Number.parseInt(limit, 10)  || 200));
    const safeBefore = Math.max(0,               Number.parseInt(before, 10)  || 0);
    const safeFrom   = Math.max(0,               Number.parseInt(from, 10)    || 0);

    let items, prevRow, nextBefore, nextAfter;
    if (safeFrom > 0) {
      const rows = this._stmtLogsFrom.all(ip, safeFrom, safeLimit + 1);
      const extra = rows.length > safeLimit ? rows.pop() : null;
      prevRow = this._stmtRowBefore.get(ip, safeFrom) || null;
      items = rows.map(rowToRecord);
      nextBefore = prevRow && items.length ? items[0].id : null;
      nextAfter = extra ? extra.id : null;
    } else {
      // Fetch one extra row to detect whether older records exist
      const rows = this._stmtLogs.all(ip, safeBefore, safeBefore, safeLimit + 1);
      prevRow = rows.length > safeLimit ? rows.pop() : null;
      // rows are newest-first; reverse to chronological order for the UI
      items = rows.reverse().map(rowToRecord);
      nextBefore = prevRow && items.length ? items[0].id : null;
      nextAfter = safeBefore > 0 ? safeBefore : null;
    }

    let hasPrev = prevRow != null;
    let prevBoot = prevRow ? prevRow.boot : null;
    for (const it of items) {
      it.bootStart = it.boot !== undefined && (!hasPrev || prevBoot !== it.boot);
      hasPrev = true;
      prevBoot = it.boot ?? null;
    }

    const { cnt: total } = this._stmtCount.get(ip);

    return Promise.resolve({ items, total, before: safeBefore, from: safeFrom, nextBefore, nextAfter });
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
   * Recent crash dumps across all IPs (newest first), joined with any GitHub
   * issue created for them.
   * @param {object} opts
   * @param {number} [opts.limit=100]  Max rows (1–1000).
   * @param {string} [opts.ip]         Restrict to one controller.
   */
  listCrashes({ limit = 100, ip = null } = {}) {
    const safeLimit = Math.max(1, Math.min(1000, Number.parseInt(limit, 10) || 100));
    const ipFilter = ip ? String(ip) : null;

    const items = this._stmtCrashes.all(ipFilter, ipFilter, safeLimit).map((r) => {
      const decode = r.crash_decode || "";
      const pending = decode.includes(CRASH_PENDING_MARKER);
      let summary = "";
      if (!pending) {
        const line = decode
          .split("\n")
          .map((l) => l.replace(/\x1b\[[0-9;]*m/g, "").trim())
          .find((l) => l && !l.includes(CRASH_PENDING_MARKER));
        if (line) summary = line.length > 160 ? line.slice(0, 159) + "…" : line;
      }
      return {
        id:          r.id,
        ip:          r.ip,
        receivedAt:  r.received_at,
        boot:        r.boot != null ? r.boot : null,
        message:     (r.message || "").split("\n")[0].slice(0, 160),
        pending,
        summary,
        fingerprint: r.fingerprint  || null,
        issueUrl:    r.issue_url    || null,
        issueNumber: r.issue_number != null ? r.issue_number : null,
        soc:         r.soc          || null,
        gitVersion:  r.git_version  || null,
        smingVersion: r.sming_version || null,
        logAvailable: Boolean(r.log_available),
      };
    });

    const { cnt: total } = this._stmtCrashCount.get(ipFilter, ipFilter);
    return { items, total };
  }

  /**
   * Return the most recent `boot` counter stored for an IP from SQLite.
   * Returns 0 if no records exist or no record has a boot value.
   * Called on service startup so the in-memory boot counter resumes correctly.
   */
  lastBootFor(ip) {
    const row = this._stmtLastBoot.get(ip);
    return Promise.resolve(row?.boot ?? 0);
  }

  /** Most recent boot nonce seen for an IP, or undefined. */
  lastBootNonceFor(ip, boot = this._stmtLastBoot.get(ip)?.boot) {
    const row = boot == null ? null : this._stmtLastBootNonce.get(ip, boot);
    return row ? row.boot_nonce : undefined;
  }

  /** Latest device timestamp of a boot (MAX would be wrong after counter rollover). */
  lastDeviceTimeFor(ip, boot = this._stmtLastBoot.get(ip)?.boot) {
    const row = boot == null ? null : this._stmtLastDeviceTime.get(ip, boot);
    return row ? { deviceTime: row.device_time, receivedAt: row.received_at } : undefined;
  }

  /** Boot sessions of an IP, newest first (like `journalctl --list-boots`). */
  listBoots(ip) {
    return this._stmtBoots.all(ip).map((r) => ({
      boot:      r.boot,
      firstId:   r.first_id,
      lastId:    r.last_id,
      startedAt: r.started_at,
      endedAt:   r.ended_at,
      entries:   r.entries,
      crashes:   r.crashes,
    }));
  }

  /** Id and receive-time bounds of one boot of an IP, or null if it has no rows. */
  getBootRange(ip, boot) {
    const r = this._stmtBootRange.get(ip, boot);
    if (!r || r.first_id == null) return null;
    return { boot, firstId: r.first_id, lastId: r.last_id, startedAt: r.started_at, endedAt: r.ended_at };
  }

  /**
   * Iterate the rows of an IP in id order, optionally bounded by id range,
   * inclusive ISO receive-time range and boot. No other statement may run on
   * this connection until the iterator is exhausted.
   */
  *iterateLogs(ip, { minId = 0, maxId = Number.MAX_SAFE_INTEGER, since = "", until = "9999-12-31T23:59:59.999Z", boot = null } = {}) {
    for (const row of this._stmtExport.iterate({ ip, minId, maxId, since, until, boot })) {
      yield rowToRecord(row);
    }
  }

  /**
   * Resolve the id of the first row of a neighbouring boot session.
   *  - prev: first row of the boot that the row just before `currentId` belongs to
   *          (i.e. the start of the current boot if `currentId` is mid-boot,
   *          otherwise the start of the preceding boot)
   *  - next: first row after `currentId` whose boot differs from `currentId`'s
   * @param {string} ip
   * @param {number} currentId
   * @param {'prev' | 'next'} direction
   * @returns {{ id: number, boot: number } | null}
   */
  getBootJumpTarget(ip, currentId, direction = 'prev') {
    if (direction === 'prev') {
      const ref = this._stmtBootRowBefore.get(ip, currentId);
      if (!ref) return null;
      const first = this._stmtFirstIdOfBoot.get(ip, ref.boot);
      return first && first.id != null ? { id: first.id, boot: ref.boot } : null;
    }
    const cur = this._stmtBootOfRow.get(ip, currentId);
    const curBoot = cur && cur.boot != null ? cur.boot : null;
    const next = this._stmtNextBootStart.get(ip, currentId, curBoot, curBoot);
    if (!next || next.id == null) return null;
    const boot = this._stmtBootOfRow.get(ip, next.id);
    return { id: next.id, boot: boot ? boot.boot : null };
  }
}

module.exports = { LogStorage };
