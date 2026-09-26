const path = require("path");

function envInt(name, fallback) {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const config = {
  host: process.env.LLS_HTTP_HOST || "0.0.0.0",
  httpPort: envInt("LLS_HTTP_PORT", 4821),
  udpHost: process.env.LLS_UDP_HOST || "0.0.0.0",
  udpPort: envInt("LLS_UDP_PORT", 5514),
  dataDir: process.env.LLS_DATA_DIR || path.join(process.cwd(), "data", "logs"),
  maxBytesPerIp: envInt("LLS_MAX_BYTES_PER_IP", 20 * 1024 * 1024),
  retentionDays: envInt("LLS_RETENTION_DAYS", 7),
  corsOrigin: process.env.LLS_CORS_ORIGIN || "*",
  serviceName: process.env.LLS_SERVICE_NAME || "LightinatorLogService",
  mdnsHost: process.env.LLS_MDNS_HOST || "lightinator-logservice.local",
  lokiConfigFile: process.env.LLS_LOKI_CONFIG || path.join(process.cwd(), "data", "loki.json"),
  discoverySeedHosts: (process.env.LLS_DISCOVERY_SEEDS || "lightinator.local").split(",").map(s => s.trim()).filter(Boolean),
  discoveryControllerPort: envInt("LLS_DISCOVERY_PORT", 80),
  discoveryRefreshMs: envInt("LLS_DISCOVERY_REFRESH_MS", 300_000),
  controllerStaleDays: envInt("LLS_CONTROLLER_STALE_DAYS", 30),
  controllerStatePath: process.env.LLS_CONTROLLER_STATE || path.join(process.cwd(), "data", "controllers.json"),
  dbPath: process.env.LLS_DB_PATH || path.join(process.cwd(), "data", "db.sqlite"),
  maxRowsPerIp: envInt("LLS_MAX_ROWS_PER_IP", 10_000),
  serviceEnvPath: process.env.LLS_SERVICE_ENV || path.join(process.cwd(), "data", "service.env"),
  syslogAdvertiseHost: process.env.LLS_SYSLOG_ADVERTISE_HOST || "",
  elfCacheDir: process.env.LLS_ELF_CACHE_DIR || path.join(process.cwd(), "data", "elfs"),
  elfBaseUrl: process.env.LLS_ELF_BASE_URL || "http://lightinator.de/download",
  githubToken: process.env.LLS_GITHUB_TOKEN || "",
  githubRepo:  process.env.LLS_GITHUB_REPO || "",
  autoCreateIssues: process.env.LLS_AUTO_CREATE_ISSUES === "true",
  geminiApiKey: process.env.LLS_GEMINI_API_KEY || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "",
  geminiModel: process.env.GEMINI_MODEL || "gemini-2.5-flash",
  aiEnabled: process.env.LLS_AI_ENABLED !== "false",
};

module.exports = { config };