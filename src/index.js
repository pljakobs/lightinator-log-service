const dgram = require("dgram");
const path = require("path");
const fs = require("fs/promises");
const express = require("express");
const cors = require("cors");
const os = require("os");

const { config } = require("./config");
const { parseSyslogLine } = require("./syslogParser");
const { LogStorage } = require("./storage");
const { advertiseMdns } = require("./mdns");
const { LokiForwarder } = require("./loki");
const { ControllerDiscovery } = require("./discovery");
const { CrashDecoder } = require("./crashDecoder");
const { version: pkgVersion } = require("../package.json");
const version = process.env.APP_VERSION || pkgVersion;
const { SETTINGS_SCHEMA, readServiceEnv, writeServiceEnv } = require("./serviceConfig");

function listCollectorIpv4Addresses() {
  const interfaces = os.networkInterfaces();
  const ips = [];

  for (const entries of Object.values(interfaces)) {
    for (const entry of entries || []) {
      if (entry.family !== "IPv4" || entry.internal) {
        continue;
      }
      ips.push(entry.address);
    }
  }

  return [...new Set(ips)];
}

/**
 * Pick the best IP to advertise to controllers for syslog delivery.
 * Preference order:
 *   1. LLS_SYSLOG_ADVERTISE_HOST env var (explicit override)
 *   2. Only one non-loopback IPv4 → use it
 *   3. Multiple IPs → prefer one on the same /24 as the first seed
 *   4. Fallback: first IP in the list
 */
function resolveAdvertiseHost(seedHosts) {
  if (config.syslogAdvertiseHost) return config.syslogAdvertiseHost;
  const ips = listCollectorIpv4Addresses();
  if (!ips.length) return "";
  if (ips.length === 1) return ips[0];

  // Try to find an IP on the same /24 as the first seed that looks like an IP
  const seed = seedHosts.find(s => /^\d+\.\d+\.\d+\.\d+$/.test(s));
  if (seed) {
    const seedPrefix = seed.split(".").slice(0, 3).join(".");
    const match = ips.find(ip => ip.startsWith(seedPrefix + "."));
    if (match) return match;
  }
  return ips[0];
}

/** Current effective runtime values for display in the UI */
function getLiveValues() {
  return {
    LLS_DISCOVERY_SEEDS: config.discoverySeedHosts.join(","),
    LLS_SYSLOG_ADVERTISE_HOST: config.syslogAdvertiseHost || "",
    LLS_UDP_PORT: String(config.udpPort),
    LLS_HTTP_PORT: String(config.httpPort),
    LLS_RETENTION_DAYS: String(config.retentionDays),
    LLS_MAX_BYTES_PER_IP: String(config.maxBytesPerIp),
    LLS_DISCOVERY_REFRESH_MS: String(config.discoveryRefreshMs),
    LLS_MDNS_HOST: config.mdnsHost,
  };
}

async function main() {
  // Ensure the data directory exists (parent of loki.json, controllers.json, service.env)
  await fs.mkdir(path.dirname(config.lokiConfigFile), { recursive: true });

  const storage = new LogStorage({
    dataDir: config.dataDir,
    maxBytesPerIp: config.maxBytesPerIp,
  });
  await storage.init();

  const loki = new LokiForwarder({ configPath: config.lokiConfigFile });
  await loki.loadConfig();

  const crashDecoder = new CrashDecoder({
    elfCacheDir: config.elfCacheDir,
    elfBaseUrl:  config.elfBaseUrl,
    onDecoded: (syntheticRecord) => {
      // Store and forward decoded crash output as a separate log entry
      storage.append(syntheticRecord.sourceIp, syntheticRecord).catch(() => {});
      loki.forward({ ...syntheticRecord, tag: (syntheticRecord.tag || "") + ":crash-decode" });
    },
  });

  // Resolve the IP to advertise to controllers for syslog delivery
  const advertiseHost = resolveAdvertiseHost(config.discoverySeedHosts);
  if (advertiseHost) {
    config.syslogAdvertiseHost = advertiseHost;
    console.log(`Syslog advertise host: ${advertiseHost}`);
  } else {
    console.warn("Could not determine syslog advertise host — logging toggle will filter locally only");
  }

  const discovery = new ControllerDiscovery({
    seedHosts: config.discoverySeedHosts,
    controllerPort: config.discoveryControllerPort,
    refreshIntervalMs: config.discoveryRefreshMs,
    statePath: config.controllerStatePath,
    onUpdate: (controllers) => {
      // Push group memberships back into Loki controller config
      // so streams are labelled with group names automatically.
      const lokiControllers = {};
      for (const c of controllers) {
        const groupName = c.groups[0]?.name || "";
        const existing = (loki.config.controllers || {})[c.ip] || {};
        lokiControllers[c.ip] = {
          group: existing.group || groupName,
          labels: existing.labels || { controller_name: c.name },
        };
      }
      // Merge, don't overwrite any user-set controller config
      loki.config.controllers = { ...lokiControllers, ...(loki.config.controllers || {}) };
    },
  });
  discovery.start();

  const app = express();
  app.use(cors({ origin: config.corsOrigin }));
  app.use(express.json({ limit: "1mb" }));
  app.use(express.static(path.join(__dirname, "ui")));

  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      service: config.serviceName,
      version,
      uptimeSec: Math.floor(process.uptime()),
    });
  });

  app.get("/api/v1/health", (_req, res) => {
    res.json({ status: "ok", version });
  });

  app.get("/api/v1/service-info", (req, res) => {
    res.json({
      serviceName: config.serviceName,
      host: os.hostname(),
      http: {
        host: config.host,
        port: config.httpPort,
      },
      udp: {
        host: config.udpHost,
        port: config.udpPort,
      },
      storage: {
        dataDir: config.dataDir,
        maxBytesPerIp: config.maxBytesPerIp,
        retentionDays: config.retentionDays,
      },
      network: {
        ipv4: listCollectorIpv4Addresses(),
      },
      request: {
        localAddress: req.socket.localAddress || null,
      },
      capabilities: {
        mdns: true,
        perIpLogs: true,
        paging: true,
      },
      mdns: {
        host: config.mdnsHost,
        services: [
          {
            name: config.serviceName,
            type: "_lightinator-log._tcp.local",
            port: config.httpPort,
          },
          {
            name: `${config.serviceName} Syslog`,
            type: "_lightinator-syslog._udp.local",
            port: config.udpPort,
          },
        ],
      },
    });
  });

  app.get("/api/v1/sources", (_req, res) => {
    res.json({ items: storage.listSources() });
  });

  app.get("/api/v1/logs", async (req, res, next) => {
    try {
      const ip = String(req.query.ip || "").trim();
      if (!ip) {
        res.status(400).json({ error: "Missing required query parameter: ip" });
        return;
      }

      const limit = req.query.limit;
      const before = req.query.before;
      const result = await storage.getLogs({ ip, limit, before });
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  app.delete("/api/v1/logs", async (req, res, next) => {
    try {
      const ip = String(req.query.ip || "").trim();
      if (ip) {
        await storage.purgeIp(ip);
        res.json({ ok: true, purged: "ip", ip });
        return;
      }

      const all = String(req.query.all || "").toLowerCase() === "true";
      if (!all) {
        res.status(400).json({ error: "Provide ip=<address> or all=true" });
        return;
      }

      await storage.purgeAll();
      res.json({ ok: true, purged: "all" });
    } catch (err) {
      next(err);
    }
  });

  app.get("/api/v1/loki/status", (_req, res) => {
    res.json(loki.getStatus());
  });

  // ── Service config (service.env) ─────────────────────────────────────────
  app.get("/api/v1/service-config", async (_req, res) => {
    try {
      const values = await readServiceEnv(config.serviceEnvPath);
      res.json({ schema: SETTINGS_SCHEMA, values, liveValues: getLiveValues() });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/v1/service-config", async (req, res) => {
    try {
      const values = req.body.values || {};
      await writeServiceEnv(config.serviceEnvPath, values);
      res.json({ ok: true, restartRequired: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/v1/service-config/restart", (_req, res) => {
    res.json({ ok: true, message: "Restarting…" });
    // Allow response to flush before exiting; systemd Restart=always brings it back
    setTimeout(() => process.exit(0), 300);
  });

  app.get("/api/v1/loki/config", (_req, res) => {
    res.json(loki.getConfig());
  });

  app.put("/api/v1/loki/config", async (req, res, next) => {
    try {
      const { enabled, url, username, password, labels, groups, controllers, batchSize, flushIntervalMs } = req.body;
      if (url) {
        try { new URL(url); } catch {
          return res.status(400).json({ error: "Invalid Loki URL" });
        }
      }
      await loki.saveConfig({ enabled, url, username, password, labels, groups, controllers, batchSize, flushIntervalMs });
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/v1/loki/test", async (req, res) => {
    // Accept optional override config from the request body (current form values)
    const override = {};
    if (req.body.url) override.url = req.body.url;
    if (req.body.username !== undefined) override.username = req.body.username;
    if (req.body.password !== undefined) override.password = req.body.password;
    const effectiveUrl = override.url || (loki.getConfig ? loki.getConfig().url : "");
    const target = effectiveUrl ? `POST ${effectiveUrl}/loki/api/v1/push` : "(no URL configured)";
    try {
      await loki.testConnection(Object.keys(override).length ? override : null);
      res.json({ ok: true, message: "Successfully pushed test entry to Loki", target });
    } catch (err) {
      res.status(502).json({ error: err.message, target });
    }
  });

  // Discovery API
  app.get("/api/v1/controllers", (_req, res) => {
    res.json({ items: discovery.getAll() });
  });

  app.post("/api/v1/controllers/refresh", async (_req, res) => {
    try {
      await discovery.refresh();
      res.json({ ok: true, items: discovery.getAll() });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.patch("/api/v1/controllers/:ip/logging", async (req, res) => {
    const ip = req.params.ip;
    const { enabled } = req.body;
    if (typeof enabled !== "boolean") {
      return res.status(400).json({ error: "enabled must be boolean" });
    }
    const ok = discovery.setLogging(ip, enabled);
    if (!ok) return res.status(404).json({ error: "Controller not found" });

    // Push rsyslog config to firmware if we know our own advertise address
    let firmwareUpdated = false;
    if (config.syslogAdvertiseHost) {
      try {
        const controllerPort = config.discoveryControllerPort;
        const payload = {
          network: {
            rsyslog: {
              enabled,
              host: config.syslogAdvertiseHost,
              port: config.udpPort,
            },
          },
        };
        const resp = await fetch(`http://${ip}:${controllerPort}/config`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(5000),
        });
        if (!resp.ok) {
          throw new Error(`Firmware returned ${resp.status}`);
        }
        firmwareUpdated = true;
      } catch (err) {
        console.warn(`Failed to push rsyslog config to ${ip}: ${err.message}`);
        return res.status(502).json({
          error: `Local flag updated but firmware push failed: ${err.message}`,
          loggingEnabled: enabled,
          firmwareUpdated: false,
        });
      }
    }

    res.json({ ok: true, ip, loggingEnabled: enabled, firmwareUpdated });
  });

  app.use((err, _req, res, _next) => {
    console.error("Unhandled error:", err);
    res.status(500).json({ error: "Internal server error" });
  });

  const server = app.listen(config.httpPort, config.host, () => {
    console.log(
      `HTTP API listening on http://${config.host}:${config.httpPort}`,
    );
  });

  const udpServer = dgram.createSocket("udp4");
  udpServer.on("error", (err) => {
    console.error("UDP server error:", err);
  });

  udpServer.on("message", async (msg, rinfo) => {
    try {
      const raw = msg.toString("utf8");
      const record = parseSyslogLine(raw, rinfo.address);
      await storage.append(rinfo.address, record);
      discovery.addSeenIp(rinfo.address);
      if (discovery.isLoggingEnabled(rinfo.address)) {
        loki.forward(record);
      }
      // Feed to crash decoder regardless of logging toggle — crash context
      // is always valuable. The decoder only acts on matching lines.
      crashDecoder.feed(record);
    } catch (err) {
      console.error("Failed processing UDP packet:", err);
    }
  });

  udpServer.bind(config.udpPort, config.udpHost, () => {
    console.log(`UDP syslog listening on ${config.udpHost}:${config.udpPort}`);
  });

  const mdns = advertiseMdns({
    serviceName: config.serviceName,
    httpPort: config.httpPort,
    udpPort: config.udpPort,
    mdnsHost: config.mdnsHost,
  });

  console.log(`mDNS host announced as ${mdns.info.host}`);
  for (const svc of mdns.info.services) {
    console.log(`mDNS service ${svc.type} name=\"${svc.name}\" port=${svc.port}`);
  }

  const shutdown = () => {
    console.log("Shutting down...");
    mdns.stop();
    loki.stop();
    discovery.stop();
    udpServer.close();
    server.close(() => process.exit(0));
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
