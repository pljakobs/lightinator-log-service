/**
 * serviceConfig.js
 *
 * Read and write the runtime service.env configuration file.
 */

const fs = require("fs/promises");
const path = require("path");

const SETTINGS_SCHEMA = [
  {
    key: "LLS_DISCOVERY_SEEDS",
    label: "Discovery seeds",
    description: "Comma-separated controller IPs or hostnames used to bootstrap discovery.",
    placeholder: "lightinator.local",
    type: "text",
  },
  {
    key: "LLS_SYSLOG_ADVERTISE_HOST",
    label: "Syslog advertise host",
    description: "IP or hostname of THIS host as reachable by controllers.",
    placeholder: "auto-detect from browser URL",
    type: "text",
    autoDetect: true,
  },
  {
    key: "LLS_UDP_PORT",
    label: "Syslog UDP port",
    description: "UDP port the service listens on for incoming syslog messages.",
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
    description: "Maximum log lines stored per controller.",
    placeholder: "10000",
    type: "number",
  },
  {
    key: "LLS_DISCOVERY_REFRESH_MS",
    label: "Discovery refresh interval (ms)",
    description: "How often to re-query the controller network.",
    placeholder: "300000",
    type: "number",
  },
  {
    key: "LLS_CONTROLLER_STALE_DAYS",
    label: "Auto-remove controllers not seen for (days)",
    description: "Controllers with no logs for this many days are removed automatically.",
    placeholder: "30",
    type: "number",
  },
  {
    key: "LLS_MDNS_HOST",
    label: "mDNS hostname",
    description: "Hostname announced via mDNS.",
    placeholder: "lightinator-logservice.local",
    type: "text",
  },
  {
    key: "LLS_GITHUB_TOKEN",
    label: "GitHub Personal Access Token",
    type: "password",
    category: "GitHub Integration",
    description: "Personal access token with 'repo' scope to create crash issues."
  },
  {
    key: "LLS_GITHUB_REPO",
    label: "GitHub Repository",
    type: "text",
    category: "GitHub Integration",
    description: "Target repository in owner/repo format."
  },
  {
    key: "LLS_AUTO_CREATE_ISSUES",
    label: "Auto-create GitHub issues on crash",
    type: "boolean",
    default: "false",
    description: "Automatically log a GitHub issue when a firmware crash is decoded.",
  },
  {
    key: "GEMINI_API_KEY",
    label: "Gemini API Key",
    type: "password",
    category: "AI Integration",
    description: "API key for Google Gemini to power automated crash root-cause analysis."
  },
  {
    key: "GEMINI_MODEL",
    label: "Gemini Model",
    type: "text",
    category: "AI Integration",
    description: "Model identifier to use for analysis (default: gemini-2.5-flash)."
  },
  {
    key: "LLS_AI_ENABLED",
    label: "Enable Automated AI Crash Analysis",
    type: "boolean",
    default: "true",
    category: "AI Integration",
    description: "Automatically execute multi-pass code-context-aware AI analysis upon crash decode."
  },
];

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
    return {};
  }
}

async function writeServiceEnv(envPath, values) {
  await fs.mkdir(path.dirname(envPath), { recursive: true });
  const lines = [
    "# lightinator-log-service runtime configuration",
    "# Edited via web UI — restart the service for changes to take effect.",
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