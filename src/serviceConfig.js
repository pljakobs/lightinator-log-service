/**
 * serviceConfig.js
 *
 * Read and write the runtime service.env configuration file.
 */

const fs = require("fs/promises");
const path = require("path");
const dotenv = require("dotenv");
const { defaultAIBackends, parseAIBackends, publicAIBackends, mergeAIBackends } = require("./aiConfig");

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
  { key: "LLS_MAX_BYTES_PER_IP", label: "Max stored text bytes per controller", type: "number", default: "20971520", description: "UTF-8 log and crash text budget; 0 disables the limit." },
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
    category: "GitHub Integration",
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
    description: "Model identifier to use for analysis (default: gemini-3.8-flash)."
  },
  {
    key: "LLS_AI_ENABLED",
    label: "Enable Automated AI Crash Analysis",
    type: "boolean",
    default: "true",
    category: "AI Integration",
    description: "Automatically execute multi-pass code-context-aware AI analysis upon crash decode."
  },
  { key: "LLS_AI_BACKENDS", label: "AI backends", type: "ai-backends", category: "AI Integration", description: "Ordered providers and model fallback lists." },
  { key: "LLS_AI_CONTEXT_ROUNDS", label: "Maximum context rounds", type: "number", default: "3", category: "AI Integration", description: "Maximum source-gathering rounds before final analysis (0-10)." },
  { key: "LLS_AI_CONTEXT_BYTES", label: "Source context budget (bytes)", type: "number", default: "120000", category: "AI Integration", description: "Maximum total UTF-8 source context supplied to analysis." },
  { key: "LLS_HTTP_HOST", label: "HTTP bind address", type: "text", description: "Address for the HTTP listener." },
  { key: "LLS_UDP_HOST", label: "Syslog bind address", type: "text", description: "Address for the UDP listener." },
  { key: "LLS_DISCOVERY_PORT", label: "Controller HTTP port", type: "number", description: "HTTP port used for controller discovery and configuration." },
  { key: "LLS_CORS_ORIGIN", label: "Allowed browser origin", type: "text", description: "Browser origin allowed by CORS, or *." },
  { key: "LLS_SERVICE_NAME", label: "Service name", type: "text", description: "Service identity advertised over mDNS." },
  { key: "LLS_ELF_BASE_URL", label: "Firmware artifact URL", type: "url", description: "Base HTTP(S) URL for firmware ELF and map files." },
];

const GEMINI_KEYS = ["LLS_GEMINI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY"];
const SECRET_KEYS = new Set([
  ...SETTINGS_SCHEMA.filter(setting => setting.type === "password").map(setting => setting.key),
  ...GEMINI_KEYS,
]);

function getServiceCredential(values, key, environment = process.env) {
  const keys = GEMINI_KEYS.includes(key) ? GEMINI_KEYS : [key];
  for (const candidate of keys) {
    if (Object.hasOwn(values, candidate)) return values[candidate];
  }
  for (const candidate of keys) {
    if (environment[candidate]) return environment[candidate];
  }
  return "";
}

function getPublicServiceConfig(values, liveValues = {}, environment = process.env) {
  const publicKeys = SETTINGS_SCHEMA.filter(setting => !SECRET_KEYS.has(setting.key) && setting.key !== "LLS_AI_BACKENDS").map(setting => setting.key);
  let backends = [];
  const configurationErrors = [];
  try { backends = getAIBackends(values, environment); } catch { configurationErrors.push("Invalid AI backend configuration; update the AI settings."); }
  return {
    schema: SETTINGS_SCHEMA.map(setting => SECRET_KEYS.has(setting.key) ? { ...setting, writeOnly: true } : setting),
    values: { ...Object.fromEntries(publicKeys.filter(key => Object.hasOwn(values, key)).map(key => [key, values[key]])),
      LLS_AI_BACKENDS: JSON.stringify(publicAIBackends(backends)) },
    configurationErrors,
    liveValues: Object.fromEntries(publicKeys.filter(key => Object.hasOwn(liveValues, key)).map(key => [key, liveValues[key]])),
    credentialsConfigured: Object.fromEntries(SETTINGS_SCHEMA.filter(setting => SECRET_KEYS.has(setting.key))
      .map(setting => [setting.key, Boolean(getServiceCredential(values, setting.key, environment))])),
  };
}

function getAIBackends(values, environment = process.env) {
  const configured = values.LLS_AI_BACKENDS ?? environment.LLS_AI_BACKENDS;
  const backends = configured ? parseAIBackends(configured) : defaultAIBackends(getServiceCredential(values, "GEMINI_API_KEY", environment), values.GEMINI_MODEL || environment.GEMINI_MODEL);
  return backends.map(backend => backend.useLegacyToken ? { ...backend, token: getServiceCredential(values, "GEMINI_API_KEY", environment) } : backend);
}

async function readServiceEnv(envPath) {
  try {
    const raw = await fs.readFile(envPath, "utf8");
    const values = dotenv.parse(raw);
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq < 1) continue;
      const key = trimmed.slice(0, eq).trim().replace(/^export\s+/, "");
      const val = trimmed.slice(eq + 1).trim();
      if (/^[A-Z_][A-Z0-9_]*$/.test(key) && !/^["'`]/.test(val)) values[key] = val;
    }
    return values;
  } catch {
    return {};
  }
}

async function loadServiceEnvironment(envPath, environment = process.env) {
  const unquote = value => typeof value === "string" && /^(["'`])[\s\S]*\1$/.test(value)
    ? dotenv.parse(`VALUE=${value}`).VALUE ?? value : value;
  const values = await readServiceEnv(unquote(envPath));
  const keys = new Set([...Object.keys(values), ...SETTINGS_SCHEMA.map(setting => setting.key), ...SECRET_KEYS,
    "LLS_SERVICE_ENV", "LLS_DB_PATH", "LLS_DATA_DIR", "LLS_LOKI_CONFIG", "LLS_CONTROLLER_STATE", "LLS_ELF_CACHE_DIR"]);
  for (const key of keys) {
    if (environment[key]) environment[key] = unquote(environment[key]);
  }
  for (const [key, value] of Object.entries(values)) {
    if (value && !environment[key]) environment[key] = value;
  }
  return values;
}

async function writeServiceEnv(envPath, values) {
  if (!values || typeof values !== "object" || Array.isArray(values)) {
    throw Object.assign(new Error("Invalid service settings"), { status: 400 });
  }
  const allowedKeys = new Set([...SETTINGS_SCHEMA.filter(setting => !setting.readOnly).map(setting => setting.key), ...SECRET_KEYS]);
  for (const [key, value] of Object.entries(values)) {
    const setting = SETTINGS_SCHEMA.find(entry => entry.key === key);
    if (setting?.type === "number" && value !== "" && !Number.isInteger(Number(value))) {
      throw Object.assign(new Error("Numeric settings require integers"), { status: 400 });
    }
    if ((key === "LLS_AI_CONTEXT_ROUNDS" && value !== "" && (!Number.isInteger(Number(value)) || Number(value) < 0 || Number(value) > 10)) ||
        (key === "LLS_AI_CONTEXT_BYTES" && value !== "" && (!Number.isInteger(Number(value)) || Number(value) < 1024 || Number(value) > 1_048_576))) {
      throw Object.assign(new Error("AI context limits are outside the supported range"), { status: 400 });
    }
    if (!allowedKeys.has(key) || (value === null && !SECRET_KEYS.has(key)) ||
        (value !== null && (!["string", "number", "boolean"].includes(typeof value) || /[\r\n\0]/.test(String(value))))) {
      throw Object.assign(new Error("Invalid service setting value"), { status: 400 });
    }
  }
  const updated = await readServiceEnv(envPath);
  for (const [key, value] of Object.entries(values)) {
    if (key === "LLS_AI_BACKENDS") {
      let previous = [];
      try { previous = getAIBackends(updated); } catch {}
      if (value) updated[key] = JSON.stringify(mergeAIBackends(value, previous));
      continue;
    }
    if (SECRET_KEYS.has(key) && value === "") continue;
    if (GEMINI_KEYS.includes(key)) {
      for (const alias of GEMINI_KEYS) delete updated[alias];
    }
    if (value === "" && !SECRET_KEYS.has(key)) delete updated[key];
    else updated[key] = value === null ? "" : String(value);
  }
  await fs.mkdir(path.dirname(envPath), { recursive: true });
  const lines = [
    "# lightinator-log-service runtime configuration",
    "# Edited via web UI — restart the service for changes to take effect.",
    "",
  ];
  for (const s of SETTINGS_SCHEMA) {
    const val = updated[s.key];
    lines.push(`# ${s.label}: ${s.description}`);
    if (val !== undefined && (val !== "" || SECRET_KEYS.has(s.key))) {
      lines.push(`${s.key}=${val}`);
    } else {
      lines.push(`#${s.key}=`);
    }
    lines.push("");
  }
  const schemaKeys = new Set(SETTINGS_SCHEMA.map(setting => setting.key));
  for (const [key, value] of Object.entries(updated)) {
    if (!schemaKeys.has(key) && /^[A-Z_][A-Z0-9_]*$/.test(key)) lines.push(`${key}=${value}`);
  }
  await fs.writeFile(envPath, lines.join("\n"), { encoding: "utf8", mode: 0o600 });
  await fs.chmod(envPath, 0o600);
}

module.exports = { SETTINGS_SCHEMA, readServiceEnv, writeServiceEnv, loadServiceEnvironment, getServiceCredential, getPublicServiceConfig, getAIBackends };