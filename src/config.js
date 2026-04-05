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
  // Discovery: comma-separated seed hostnames/IPs to bootstrap controller discovery
  discoverySeedHosts: (process.env.LLS_DISCOVERY_SEEDS || "lightinator.local").split(",").map(s => s.trim()).filter(Boolean),
  discoveryControllerPort: envInt("LLS_DISCOVERY_PORT", 80),
  discoveryRefreshMs: envInt("LLS_DISCOVERY_REFRESH_MS", 300_000),
  // The IP/hostname controllers should use to reach this service's syslog UDP port.
  // Required for the logging toggle to push rsyslog config to firmware.
  // If unset, the toggle falls back to a local filter only.
  syslogAdvertiseHost: process.env.LLS_SYSLOG_ADVERTISE_HOST || "",
};

module.exports = { config };
