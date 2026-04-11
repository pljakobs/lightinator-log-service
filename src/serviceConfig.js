/**
 * serviceConfig.js
 *
 * Read and write the runtime service.env configuration file.
 * The file format is a subset of shell env syntax:
 *   - Lines starting with # are comments (preserved on read, regenerated on write)
 *   - KEY=VALUE pairs (no quoting required for simple values)
 *   - Blank lines ignored
 */

const fs = require("fs/promises");
const path = require("path");

// All known LLS_* settings with defaults and descriptions shown in the UI.
const SETTINGS_SCHEMA = [
  {
    key: "LLS_DISCOVERY_SEEDS",
    label: "Discovery seeds",
    description: "Comma-separated controller IPs or hostnames used to bootstrap discovery. One reachable seed is enough — all peers are found via /hosts?all=true.",
    placeholder: "lightinator.local",
    type: "text",
  },
  {
    key: "LLS_SYSLOG_ADVERTISE_HOST",
    label: "Syslog advertise host",
    description: "IP or hostname of THIS host as reachable by controllers. Used when toggling logging ON/OFF to push the syslog target address to firmware. Leave blank to auto-detect.",
    placeholder: "auto-detect from browser URL",
    type: "text",
    autoDetect: true,
  },
  {
    key: "LLS_UDP_PORT",
    label: "Syslog UDP port",
    description: "UDP port the service listens on for incoming syslog messages. Must match network.rsyslog.port on the firmware.",
    placeholder: "5514",
    type: "number",
  },
  {
    key: "LLS_HTTP_PORT",
    label: "HTTP port",
    description: "TCP port for the web UI and REST API.",
    placeholder: "4821",
    type: "number",
  },
  {
    key: "LLS_RETENTION_DAYS",
    label: "Log retention (days)",
    description: "How many days of logs to keep before automatic pruning.",
    placeholder: "7",
    type: "number",
  },
  {
    key: "LLS_MAX_ROWS_PER_IP",
    label: "Max log rows per controller",
    description: "Maximum log lines stored per controller before oldest lines are trimmed. Default 10000.",
    placeholder: "10000",
    type: "number",
  },
  {
    key: "LLS_DISCOVERY_REFRESH_MS",
    label: "Discovery refresh interval (ms)",
    description: "How often to re-query the controller network. Default 300000 (5 minutes).",
    placeholder: "300000",
    type: "number",
  },
  {
    key: "LLS_MDNS_HOST",
    label: "mDNS hostname",
    description: "Hostname announced via mDNS so browsers can find the UI at http://<name>:<port>.",
    placeholder: "lightinator-logservice.local",
    type: "text",
  },
];

/**
 * Parse a service.env file into a key→value map (active lines only).
 */
async function readServiceEnv(envPath) {
  try {
    const raw = await fs.readFile(envPath, "utf8");
    const values = {};
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq < 1) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim();
      values[key] = val;
    }
    return values;
  } catch {
    return {}; // file missing → all defaults
  }
}

/**
 * Write a key→value map back to the service.env file.
 * Entries with empty string values are written as commented-out lines.
 */
async function writeServiceEnv(envPath, values) {
  await fs.mkdir(path.dirname(envPath), { recursive: true });
  const lines = [
    "# lightinator-log-service runtime configuration",
    "# Edited via web UI — restart the service for changes to take effect.",
    "# systemctl restart lightinator-log-service",
    "",
  ];
  for (const s of SETTINGS_SCHEMA) {
    const val = values[s.key];
    lines.push(`# ${s.label}: ${s.description}`);
    if (val !== undefined && val !== "") {
      lines.push(`${s.key}=${val}`);
    } else {
      lines.push(`#${s.key}=`);
    }
    lines.push("");
  }
  await fs.writeFile(envPath, lines.join("\n"), "utf8");
}

module.exports = { SETTINGS_SCHEMA, readServiceEnv, writeServiceEnv };
