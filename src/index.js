const dgram = require("dgram");
const path = require("path");
const express = require("express");
const cors = require("cors");
const os = require("os");

const { config } = require("./config");
const { parseSyslogLine } = require("./syslogParser");
const { LogStorage } = require("./storage");
const { advertiseMdns } = require("./mdns");
const { LokiForwarder } = require("./loki");
const { ControllerDiscovery } = require("./discovery");

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

async function main() {
  const storage = new LogStorage({
    dataDir: config.dataDir,
    maxBytesPerIp: config.maxBytesPerIp,
  });
  await storage.init();

  const loki = new LokiForwarder({ configPath: config.lokiConfigFile });
  await loki.loadConfig();

  const discovery = new ControllerDiscovery({
    seedHosts: config.discoverySeedHosts,
    controllerPort: config.discoveryControllerPort,
    refreshIntervalMs: config.discoveryRefreshMs,
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
      uptimeSec: Math.floor(process.uptime()),
    });
  });

  app.get("/api/v1/health", (_req, res) => {
    res.json({ status: "ok" });
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

  app.post("/api/v1/loki/test", async (_req, res) => {
    try {
      await loki.testConnection();
      res.json({ ok: true, message: "Successfully pushed test entry to Loki" });
    } catch (err) {
      res.status(502).json({ error: err.message });
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

  app.patch("/api/v1/controllers/:ip/logging", (req, res) => {
    const ip = req.params.ip;
    const { enabled } = req.body;
    if (typeof enabled !== "boolean") {
      return res.status(400).json({ error: "enabled must be boolean" });
    }
    const ok = discovery.setLogging(ip, enabled);
    if (!ok) return res.status(404).json({ error: "Controller not found" });
    res.json({ ok: true, ip, loggingEnabled: enabled });
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
