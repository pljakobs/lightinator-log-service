/**
 * Plain-text log downloads: resolves a download scope to a row filter and
 * renders the matching rows (plus an optional decoded crash) as text.
 */

const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;
const CHUNK_BYTES = 64 * 1024;

const SCOPES = ["all", "boot", "current", "previous", "range", "crash"];

class ExportError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const stripAnsi = (text) => String(text ?? "").replace(ANSI_RE, "");
const safeFilePart = (text) => String(text).replace(/[^A-Za-z0-9._-]+/g, "_");

function parseTimestamp(value, name) {
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) throw new ExportError(400, `Invalid ${name} timestamp`);
  return date.toISOString();
}

function parseInteger(value, name) {
  const parsed = Number(value);
  if (value == null || value === "" || !Number.isInteger(parsed)) throw new ExportError(400, `Invalid ${name}`);
  return parsed;
}

function requireBoot(storage, ip, boot, what) {
  const range = boot == null ? null : storage.getBootRange(ip, boot);
  if (!range) throw new ExportError(404, `No ${what} found for ${ip}`);
  return range;
}

/**
 * Translate download query parameters into an export description.
 *
 *   scope=all                       every stored row of `ip`
 *   scope=boot&boot=N               one uptime (boot session) of `ip`
 *   scope=current | previous        newest / second-newest boot of `ip`
 *   scope=range&start=&end=         rows of `ip` received in [start, end]
 *   scope=crash&id=&minutes=        `minutes` before the last row of the crashed
 *                                   boot up to that row, followed by the decode
 */
function resolveLogExport(storage, query, { crashMinutes = 10 } = {}) {
  const scope = String(query.scope || "all");
  if (!SCOPES.includes(scope)) throw new ExportError(400, `Invalid scope; expected one of ${SCOPES.join(", ")}`);

  if (scope === "crash") {
    const id = parseInteger(query.id, "crash id");
    const crash = storage.getCrashRecord(id);
    if (!crash) throw new ExportError(404, "No crash decode found for this log entry");
    const minutes = query.minutes == null || query.minutes === "" ? crashMinutes : Number(query.minutes);
    if (!Number.isFinite(minutes) || minutes <= 0) throw new ExportError(400, "Invalid minutes");

    const range = crash.boot != null ? storage.getBootRange(crash.ip, crash.boot) : null;
    const lastId = range ? range.lastId : crash.id;
    const until = range ? range.endedAt : crash.receivedAt;
    const since = new Date(Date.parse(until) - minutes * 60_000).toISOString();
    return {
      ip: crash.ip,
      label: `crash ${id} (${minutes} min before end of boot ${crash.boot ?? "?"})`,
      filename: `${safeFilePart(crash.ip)}_crash-${id}.log`,
      filter: { maxId: lastId, since, until },
      crash,
    };
  }

  const ip = String(query.ip || "").trim();
  if (!ip) throw new ExportError(400, "Missing required query parameter: ip");
  const base = safeFilePart(ip);

  if (scope === "all") {
    return { ip, label: "all logs", filename: `${base}_all.log`, filter: {} };
  }

  if (scope === "range") {
    if (!query.start && !query.end) throw new ExportError(400, "Provide start and/or end");
    const since = query.start ? parseTimestamp(query.start, "start") : undefined;
    const until = query.end ? parseTimestamp(query.end, "end") : undefined;
    if (since && until && since > until) throw new ExportError(400, "start must not be after end");
    const stamp = (iso) => (iso ? iso.replace(/[:.]/g, "-") : "open");
    return {
      ip,
      label: `${since || "start"} .. ${until || "end"}`,
      filename: `${base}_${stamp(since)}_${stamp(until)}.log`,
      filter: { since, until },
    };
  }

  let range;
  if (scope === "boot") {
    range = requireBoot(storage, ip, parseInteger(query.boot, "boot"), "such boot");
  } else {
    const boots = storage.listBoots(ip);
    const index = scope === "current" ? 0 : 1;
    range = requireBoot(storage, ip, boots[index]?.boot, `${scope} boot`);
  }
  return {
    ip,
    label: `${scope === "boot" ? "" : `${scope} `}boot ${range.boot}`,
    filename: `${base}_boot-${range.boot}.log`,
    filter: { minId: range.firstId, maxId: range.lastId, boot: range.boot },
  };
}

function formatRecord(r) {
  const uptime = r.deviceTime != null ? ` [${String(r.deviceTime).padStart(10)}]` : "";
  const source = [r.tag, r.app].filter(Boolean).join(" ");
  return `${r.receivedAt}${uptime} ${source ? `${source}: ` : ""}${stripAnsi(r.message ?? r.raw)}`;
}

function formatCrash(crash) {
  const build = [
    crash.gitVersion && `firmware ${crash.gitVersion}`,
    crash.smingVersion && `Sming ${crash.smingVersion}`,
    crash.soc,
    crash.buildType,
  ].filter(Boolean).join(", ");
  return [
    "",
    `==== Decoded crash (log id ${crash.id}, received ${crash.receivedAt}, boot ${crash.boot ?? "?"}) ====`,
    ...(build ? [`Build: ${build}`] : []),
    "",
    stripAnsi(crash.crashDecode).trimEnd(),
    "",
  ].join("\n");
}

/** Yield the export as text chunks. */
function* renderLogExport(storage, exp, now = new Date()) {
  let buffer = [
    "# Lightinator log export",
    `# Controller: ${exp.ip}`,
    `# Scope: ${exp.label}`,
    `# Generated: ${now.toISOString()}`,
    "",
  ].join("\n") + "\n";

  let lastBoot;
  let rows = 0;
  for (const r of storage.iterateLogs(exp.ip, exp.filter)) {
    if (r.boot !== undefined && r.boot !== lastBoot) {
      buffer += `---- boot ${r.boot} ----\n`;
      lastBoot = r.boot;
    }
    buffer += formatRecord(r) + "\n";
    rows++;
    if (buffer.length >= CHUNK_BYTES) {
      yield buffer;
      buffer = "";
    }
  }
  if (!rows) buffer += "# (no log entries)\n";
  if (exp.crash) buffer += formatCrash(exp.crash);
  if (buffer) yield buffer;
}

module.exports = { resolveLogExport, renderLogExport, ExportError };
