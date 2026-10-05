const dgram = require("dgram");
const path = require("path");
const fs = require("fs/promises");
const express = require("express");
const cors = require("cors");
const os = require("os");

const { config, loadConfig } = require("./config");
const { parseSyslogLine } = require("./syslogParser");
const { BootTracker } = require("./bootTracker");
const { LogStorage } = require("./storage");
const { openDatabase } = require("./db");
const { initializeServiceData } = require("./startupWorker");
const { advertiseMdns } = require("./mdns");
const { LokiForwarder } = require("./loki");
const { ControllerDiscovery } = require("./discovery");
const { CrashDecoder } = require("./crashDecoder");
const { CrashReporter } = require("./crashReporter");
const { FirmwareUpdater } = require("./firmwareUpdater");
const { version: pkgVersion } = require("../package.json");
const { AIService } = require("./aiService");
const version = process.env.APP_VERSION || pkgVersion;
const { readServiceEnv, writeServiceEnv, loadServiceEnvironment, getServiceCredential, getPublicServiceConfig, getAIBackends } = require("./serviceConfig");

const buildNumber = process.env.BUILD_NUMBER || 'dev';
const gitVersion = process.env.GIT_VERSION || 'local';

const changelogPath = path.join(__dirname, "changelog.json");
let changelogCache = null;

async function loadChangelog() {
  if (changelogCache) return changelogCache;
  try {
    const parsed = JSON.parse(await fs.readFile(changelogPath, "utf8"));
    const builds = Array.isArray(parsed.builds) ? parsed.builds : [];
    changelogCache = { generatedAt: parsed.generatedAt || null, builds };
    return changelogCache;
  } catch (err) {
    if (err.code !== "ENOENT") console.warn(`Could not read changelog: ${err.message}`);
    return { generatedAt: null, builds: [] };
  }
}

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

function resolveAdvertiseHost(seedHosts) {
  if (config.syslogAdvertiseHost) return config.syslogAdvertiseHost;
  const ips = listCollectorIpv4Addresses();
  if (!ips.length) return "";
  if (ips.length === 1) return ips[0];

  const seed = seedHosts.find(s => /^\d+\.\d+\.\d+\.\d+$/.test(s));
  if (seed) {
    const seedPrefix = seed.split(".").slice(0, 3).join(".");
    const match = ips.find(ip => ip.startsWith(seedPrefix + "."));
    if (match) return match;
  }
  return ips[0];
}

function getLiveValues() {
  return {
    LLS_DISCOVERY_SEEDS: config.discoverySeedHosts.join(","),
    LLS_SYSLOG_ADVERTISE_HOST: config.syslogAdvertiseHost || "",
    LLS_UDP_PORT: String(config.udpPort),
    LLS_HTTP_PORT: String(config.httpPort),
    LLS_RETENTION_DAYS: String(config.retentionDays),
    LLS_MAX_ROWS_PER_IP: String(config.maxRowsPerIp),
    LLS_MAX_BYTES_PER_IP: String(config.maxBytesPerIp),
    LLS_DISCOVERY_REFRESH_MS: String(config.discoveryRefreshMs),
    LLS_CONTROLLER_STALE_DAYS: String(config.controllerStaleDays),
    LLS_MDNS_HOST: config.mdnsHost,
    LLS_AI_ENABLED: String(config.aiEnabled),
    LLS_AI_CONTEXT_ROUNDS: String(config.aiContextRounds),
    LLS_AI_CONTEXT_BYTES: String(config.aiContextBytes),
    GEMINI_MODEL: config.geminiModel,
    LLS_HTTP_HOST: config.host,
    LLS_UDP_HOST: config.udpHost,
    LLS_DISCOVERY_PORT: String(config.discoveryControllerPort),
    LLS_CORS_ORIGIN: config.corsOrigin,
    LLS_SERVICE_NAME: config.serviceName,
    LLS_ELF_BASE_URL: config.elfBaseUrl,
    LLS_FIRMWARE_API_URL: config.firmwareApiUrl,
    LLS_FIRMWARE_UPDATES_ENABLED: String(config.firmwareUpdatesEnabled),
  };
}

async function main() {
  // Load persisted service environment variables into process.env prior to initialization
  const savedEnv = await loadServiceEnvironment(config.serviceEnvPath);
  Object.assign(config, loadConfig());

  await fs.mkdir(path.dirname(config.lokiConfigFile), { recursive: true });

  const loki = new LokiForwarder({ configPath: config.lokiConfigFile });
  const [initialState] = await Promise.all([
    initializeServiceData({ dbPath: config.dbPath, dataDir: config.dataDir,
      controllerStatePath: config.controllerStatePath, maxRowsPerIp: config.maxRowsPerIp,
      retentionDays: config.retentionDays, maxBytesPerIp: config.maxBytesPerIp }),
    loki.loadConfig(),
  ]);
  const db = openDatabase(config.dbPath);

  const storage = new LogStorage({
    db,
    dataDir: config.dataDir,
    maxRowsPerIp: config.maxRowsPerIp,
    retentionDays: config.retentionDays,
    maxBytesPerIp: config.maxBytesPerIp,
  });
  const retentionTimer = setInterval(() => {
    try { storage.prune(); } catch (err) { console.warn(`Log pruning failed: ${err.message}`); }
  }, 300_000);
  retentionTimer.unref();

  const bootTracker = new BootTracker();
  for (const boot of initialState.boots) {
    bootTracker.restore(boot.ip, boot.boot, boot.nonce, boot.deviceTime);
  }

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
    db,
    onUpdate: (controllers) => {
      const lokiControllers = {};
      for (const c of controllers) {
        const groupName = c.groups[0]?.name || "";
        const existing = (loki.config.controllers || {})[c.ip] || {};
        lokiControllers[c.ip] = {
          group: existing.group || groupName,
          labels: existing.labels || { controller_name: c.name },
        };
      }
      loki.config.controllers = { ...lokiControllers, ...(loki.config.controllers || {}) };
    },
  });

  discovery.controllers = new Map(initialState.controllers.map(controller => [controller.ip, controller]));
  for (const boot of initialState.boots) {
    discovery.setBootNonce(boot.ip, boot.nonce, boot.boot);
  }
  discovery.start({ loadState: false });
  let firmwareUpdater;
  const updateOptions = { getController: ip => discovery.controllers.get(ip), controllerPort: config.discoveryControllerPort };
  try { firmwareUpdater = new FirmwareUpdater({ ...updateOptions, apiUrl: config.firmwareApiUrl, enabled: config.firmwareUpdatesEnabled }); }
  catch {
    console.warn("Invalid firmware catalogue configuration; firmware updates disabled.");
    firmwareUpdater = new FirmwareUpdater(updateOptions);
  }

  const app = express();
  app.use(cors({ origin: config.corsOrigin }));
  app.use(express.json({ limit: "1mb" }));
  app.get("/vendor/dompurify.min.js", (_req, res) => {
    res.sendFile(path.join(path.dirname(require.resolve("dompurify")), "purify.min.js"));
  });
  app.use(express.static(path.join(__dirname, "ui")));

  function removeControllers(ips, purgeLogs) {
    const removed = [];
    for (const ip of ips) {
      if (!discovery.remove(ip)) continue;
      if (purgeLogs && typeof storage.purgeIp === "function") {
        storage.purgeIp(ip);
      }
      removed.push(ip);
    }
    return removed;
  }

  // Periodic auto-removal of controllers (and their logs) not seen for N days.
  const STALE_PURGE_INTERVAL_MS = 60 * 60 * 1000;
  const STALE_PURGE_INITIAL_DELAY_MS = 60 * 1000;
  const purgeStaleControllers = () => {
    const days = config.controllerStaleDays;
    if (!(days > 0)) return;
    try {
      const staleList = typeof discovery.listStale === "function" ? discovery.listStale(days) : [];
      const removed = removeControllers(staleList, true);
      if (removed.length) {
        console.log(`Stale purge: removed ${removed.length} controller(s) not seen for ${days} day(s) incl. logs: ${removed.join(", ")}`);
      }
    } catch (err) {
      console.warn(`Stale purge failed: ${err.message}`);
    }
  };
  const stalePurgeTimers = [];
  if (config.controllerStaleDays > 0) {
    console.log(`Stale purge: controllers not seen for ${config.controllerStaleDays} day(s) are removed hourly`);
    const initial = setTimeout(purgeStaleControllers, STALE_PURGE_INITIAL_DELAY_MS);
    const interval = setInterval(purgeStaleControllers, STALE_PURGE_INTERVAL_MS);
    for (const t of [initial, interval]) {
      if (t.unref) t.unref();
      stalePurgeTimers.push(t);
    }
  } else {
    console.log("Stale purge: disabled (LLS_CONTROLLER_STALE_DAYS=0)");
  }

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
      http: { host: config.host, port: config.httpPort },
      udp: { host: config.udpHost, port: config.udpPort },
      storage: {
        maxBytesPerIp: config.maxBytesPerIp,
        retentionDays: config.retentionDays,
      },
      network: { ipv4: listCollectorIpv4Addresses() },
      request: { localAddress: req.socket.localAddress || null },
      capabilities: { mdns: true, perIpLogs: true, paging: true },
      mdns: {
        host: config.mdnsHost,
        services: [
          { name: config.serviceName, type: "_lightinator-log._tcp.local", port: config.httpPort },
          { name: `${config.serviceName} Syslog`, type: "_lightinator-syslog._udp.local", port: config.udpPort },
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
      const from = req.query.from;
      const result = await storage.getLogs({ ip, limit, before, from });
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  app.get("/api/v1/logs/:id/crash-decode", async (req, res, next) => {
    try {
      const id = Number.parseInt(req.params.id, 10);
      if (!id || Number.isNaN(id)) {
        res.status(400).json({ error: "Invalid log id" });
        return;
      }
      const crashDecode = await storage.getCrashDecode(id);
      if (!crashDecode) {
        res.status(404).json({ error: "No crash decode found for this log entry" });
        return;
      }
      const record = storage.getCrashRecord(id);
      res.json({
        id,
        crashDecode,
        rawDump: record?.raw || null,
        gitVersion: record?.gitVersion || null,
        smingVersion: record?.smingVersion || null,
        soc: record?.soc || null,
        buildType: record?.buildType || null,
      });
    } catch (err) {
      next(err);
    }
  });

  app.get("/api/v1/crashes", (req, res, next) => {
    try {
      const ip = String(req.query.ip || "").trim() || null;
      res.json(storage.listCrashes({ limit: req.query.limit, ip }));
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/v1/crashes/:id/analyze", async (req, res, next) => {
    try {
      const id = Number.parseInt(req.params.id, 10);
      if (!id || Number.isNaN(id)) {
        return res.status(400).json({ error: "Invalid log id" });
      }
      if (!crashDecoder) {
        return res.status(503).json({ error: "CrashDecoder instance not available" });
      }
      const crashDecode = await crashDecoder.analyzeRecord(id);
      const record = storage.getCrashRecord(id);
      res.json({ id, crashDecode, rawDump: record?.raw || null });
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/v1/crashes/:id/decode", async (req, res, next) => {
    try {
      const id = Number.parseInt(req.params.id, 10);
      if (!id || Number.isNaN(id)) {
        return res.status(400).json({ error: "Invalid log id" });
      }
      if (!crashDecoder) {
        return res.status(503).json({ error: "CrashDecoder instance not available" });
      }
      const crashDecode = await crashDecoder.rerunRecord(id);
      const record = storage.getCrashRecord(id);
      res.json({ id, crashDecode, rawDump: record?.raw || null });
    } catch (err) {
      next(err);
    }
  });

  app.get("/api/v1/boots", (req, res, next) => {
    try {
      const ip = String(req.query.ip || "").trim();
      if (!ip) {
        res.status(400).json({ error: "Missing required query parameter: ip" });
        return;
      }
      res.json({ items: storage.listBoots(ip) });
    } catch (err) {
      next(err);
    }
  });

  app.get("/api/v1/logs/boot-jump", (req, res, next) => {
    try {
      const ip = String(req.query.ip || "").trim();
      const currentId = Number.parseInt(req.query.currentId, 10);
      const direction = req.query.direction === "next" ? "next" : "prev";

      if (!ip || Number.isNaN(currentId)) {
        return res.status(400).json({ error: "Missing or invalid parameters" });
      }

      const target = storage.getBootJumpTarget(ip, currentId, direction);
      res.json({ targetId: target ? target.id : null, boot: target ? target.boot : null });
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

  app.get("/api/v1/search", (req, res, next) => {
    try {
      const query = String(req.query.q || "").trim();
      if (!query) {
        res.status(400).json({ error: "Missing required query parameter: q" });
        return;
      }
      const result = storage.search({
        query,
        limit: req.query.limit,
        context: req.query.context,
      });
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  app.get("/api/v1/loki/status", (_req, res) => {
    res.json(loki.getStatus());
  });

  app.get("/api/v1/service-config", async (_req, res) => {
    try {
      const values = await readServiceEnv(config.serviceEnvPath);
      res.json(getPublicServiceConfig(values, getLiveValues()));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/v1/service-config", async (req, res) => {
    try {
      const values = req.body.values ?? {};
      await writeServiceEnv(config.serviceEnvPath, values);
      res.json({ ok: true, restartRequired: true });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  app.post("/api/v1/service-config/restart", (_req, res) => {
    res.json({ ok: true, message: "Restarting…" });
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
    const override = {};
    if (req.body.url) override.url = req.body.url;
    if (req.body.username !== undefined) override.username = req.body.username;
    if (req.body.password !== undefined) override.password = req.body.password;
    const effectiveUrl = override.url || (loki.getConfig ? loki.getConfig().url : "");
    let target = "(no URL configured)";
    if (effectiveUrl) {
      try {
        const url = new URL(effectiveUrl);
        target = ["http:", "https:"].includes(url.protocol) && !url.username && !url.password
          ? `POST ${url.origin}/loki/api/v1/push` : "(invalid Loki URL)";
      } catch {
        target = "(invalid Loki URL)";
      }
    }
    try {
      await loki.testConnection(Object.keys(override).length ? override : null);
      res.json({ ok: true, message: "Successfully pushed test entry to Loki", target });
    } catch (err) {
      res.status(err.status || 502).json({ error: err.message, target });
    }
  });

  app.get("/api/v1/controllers", (_req, res) => {
    res.json({ items: discovery.getAll(), firmwareUpdatesEnabled: firmwareUpdater.enabled });
  });

  app.get("/api/v1/controllers/:ip/firmware", async (req, res) => {
    try {
      res.json(await firmwareUpdater.options(req.params.ip, { branch: req.query.branch, type: req.query.type }));
    } catch (error) { res.status(error.status || 502).json({ error: error.status ? error.message : "Could not load controller firmware options" }); }
  });

  app.post("/api/v1/controllers/:ip/firmware", async (req, res) => {
    try {
      const origin = req.get("origin");
      if (req.get("sec-fetch-site") === "cross-site" || (origin && new URL(origin).host !== req.get("host"))) {
        return res.status(403).json({ error: "Cross-origin firmware update requests are not allowed" });
      }
      const job = await firmwareUpdater.start(req.params.ip, req.body);
      res.status(202).json(job);
    } catch (error) { res.status(error.status || 400).json({ error: error.status ? error.message : "Could not start firmware update" }); }
    finally { if (req.body) delete req.body.password; }
  });

  app.get("/api/v1/controllers/:ip/firmware/:jobId", (req, res) => {
    try { res.json(firmwareUpdater.status(req.params.ip, req.params.jobId)); }
    catch (error) { res.status(error.status || 400).json({ error: error.status ? error.message : "Could not load firmware update status" }); }
  });

  app.post("/api/v1/controllers/refresh", async (_req, res) => {
    try {
      await discovery.refresh();
      res.json({ ok: true, items: discovery.getAll() });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/info', (_req, res) => {
    res.json({ buildNumber, gitVersion });
  });

  app.delete("/api/v1/controllers/:ip", (req, res, next) => {
    try {
      const ip = req.params.ip;
      const purgeLogs = String(req.query.purgeLogs || "").toLowerCase() === "true";
      const removed = removeControllers([ip], purgeLogs);
      if (!removed.length) return res.status(404).json({ error: "Controller not found" });
      res.json({ ok: true, ip, purgedLogs: purgeLogs });
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/v1/controllers/remove", (req, res, next) => {
    try {
      const { ips, purgeLogs } = req.body || {};
      if (!Array.isArray(ips) || !ips.every((ip) => typeof ip === "string" && ip)) {
        return res.status(400).json({ error: "ips must be a non-empty array of strings" });
      }
      const removed = removeControllers(ips, purgeLogs === true);
      const unknown = ips.filter(ip => !removed.includes(ip));
      res.json({ ok: true, removed, unknown, purgedLogs: purgeLogs === true });
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/v1/controllers/remove-stale", (req, res, next) => {
    try {
      const { days, purgeLogs } = req.body || {};
      const n = Number(days);
      if (!Number.isFinite(n) || n < 0) {
        return res.status(400).json({ error: "days must be a non-negative number" });
      }
      const staleList = typeof discovery.listStale === "function" ? discovery.listStale(n) : [];
      const removed = removeControllers(staleList, purgeLogs === true);
      res.json({ ok: true, removed, purgedLogs: purgeLogs === true });
    } catch (err) {
      next(err);
    }
  });

  app.get("/api/v1/changelog", async (_req, res) => {
    const { generatedAt, builds } = await loadChangelog();
    res.json({ buildNumber, gitVersion, generatedAt, builds });
  });

  app.patch("/api/v1/controllers/:ip/logging", async (req, res) => {
    const ip = req.params.ip;
    const { enabled } = req.body;
    if (typeof enabled !== "boolean") {
      return res.status(400).json({ error: "enabled must be boolean" });
    }
    const ok = discovery.setLogging(ip, enabled);
    if (!ok) return res.status(404).json({ error: "Controller not found" });

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

  const crashReporter = new CrashReporter({
    db,
    githubToken: getServiceCredential(savedEnv, "LLS_GITHUB_TOKEN"),
    githubRepo: config.githubRepo,
    autoCreateIssues: config.autoCreateIssues,
  });

  let aiBackends = [];
  try { aiBackends = getAIBackends(savedEnv); } catch { console.warn("Invalid AI backend configuration; AI disabled until settings are corrected."); }
  const aiService = new AIService({
    apiKey: getServiceCredential(savedEnv, "GEMINI_API_KEY"),
    model: config.geminiModel,
    backends: aiBackends,
    contextRounds: config.aiContextRounds,
    contextBytes: config.aiContextBytes,
  });

  const crashDecoder = new CrashDecoder({
    elfCacheDir: config.elfCacheDir,
    elfBaseUrl: config.elfBaseUrl,
    discovery,
    db,
    storage,
    aiService,
    aiEnabled: config.aiEnabled,
    onDecoded: (record) => {
      const decodedContent = record.crashDecode || record.message || "";
      loki.forward({ ...record, tag: (record.tag || "") + ":crash-decode" });

      crashReporter
        .processCrash({
          logId: record.id,
          record,
          decodedText: decodedContent,
          fingerprint: record.fingerprint || "",
          exccause: record.exccause || "",
          pcFrame: record.pcFrame || "",
          tosFrame: record.tosFrame || "",
        })
        .then((result) => {
          if (result?.issueUrl) {
            console.log(`[CrashReporter] Created/updated GitHub issue: ${result.issueUrl}`);
          }
        })
        .catch((err) => {
          console.warn(`[CrashReporter] Crash reporting failed: ${err.message}`);
        });
    },
  });

  app.use((err, _req, res, _next) => {
    console.error("Unhandled error:", err);
    res.status(err.status || 500).json({ error: err.message || "Internal server error" });
  });

  const server = app.listen(config.httpPort, config.host, () => {
    console.log(`HTTP API listening on http://${config.host}:${config.httpPort}`);
  });

  const udpServer = dgram.createSocket("udp4");
  udpServer.on("error", (err) => {
    console.error("UDP server error:", err);
  });

  udpServer.on("message", async (msg, rinfo) => {
    try {
      const raw = msg.toString("utf8");
      const record = parseSyslogLine(raw, rinfo.address);
      const previousBoot = bootTracker.currentBoot(rinfo.address);
      if (!bootTracker.assign(rinfo.address, record)) return;
      const newBoot = record.boot > previousBoot;
      if (newBoot) {
        const reason = record.uptimeReset ? "uptime regression" : "new nonce";
        console.info(`Reboot detected for ${rinfo.address}: boot=${record.boot}, nonce=${record.bootNonce ?? "unknown"}, reason=${reason}`);
        discovery.setBootNonce(rinfo.address, record.bootNonce, record.boot).catch(() => {});
      }
      const controller = discovery.controllers.get(rinfo.address);
      const bootInfo = discovery.getBootInfo(rinfo.address, record.boot, record.bootNonce);
      if (controller) {
        record.gitVersion = bootInfo?.git_version || controller.gitVersion || null;
        record.smingVersion = bootInfo?.sming_version || controller.smingVersion || null;
        record.soc = bootInfo?.soc || controller.soc || null;
        record.buildType = bootInfo?.build_type || controller.buildType || null;
      } else if (bootInfo) {
        record.gitVersion = bootInfo.git_version;
        record.smingVersion = bootInfo.sming_version;
        record.soc = bootInfo.soc;
        record.buildType = bootInfo.build_type;
      }

      await storage.append(rinfo.address, record);
      discovery.addSeenIp(rinfo.address);
      discovery.recordLogReceived(rinfo.address);
      if (discovery.isLoggingEnabled(rinfo.address)) {
        loki.forward(record);
      }
      crashDecoder.feed(record);
      if (newBoot) {
        discovery.refreshControllerInfo(rinfo.address, record.bootNonce, record.boot).catch((err) => {
          console.debug(`Discovery: reboot info refresh failed for ${rinfo.address}: ${err.message}`);
        });
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
    console.log(`mDNS service ${svc.type} name="${svc.name}" port=${svc.port}`);
  }

  const shutdown = () => {
    console.log("Shutting down...");
    firmwareUpdater.stop();
    clearInterval(retentionTimer);
    for (const t of stalePurgeTimers) {
      clearTimeout(t);
      clearInterval(t);
    }
    mdns.stop();
    loki.stop();
    discovery.stop();
    udpServer.close();
    server.close(() => {
      if (db && typeof db.close === "function") {
        db.close();
      }
      process.exit(0);
    });
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});