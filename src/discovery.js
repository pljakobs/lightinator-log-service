/**
 * discovery.js
 *
 * Discovers Lightinator controllers and their group memberships by querying
 * the controller REST API:
 *
 *   GET /hosts?all=true → { hosts: [{ hostname, ip_address, id, ttl }] }
 *   GET /data           → { controllers: [{id, name, "ip-address"}],
 *                           groups: [{id, name, controller_ids:[]}] }
 *
 * Cross-join strategy:
 *   - /hosts?all=true gives us all known IPs + numeric device IDs
 *   - /data.groups[].controller_ids[] contains the string IDs from /data.controllers[].id
 *   - /data.controllers[]."ip-address" matches /hosts[].ip_address
 *   So: ip → data.controller.id → which groups include that id → group labels
 *
 * Split-brain detection:
 *   After seed fetch, /hosts?all=true is queried on every discovered IP in
 *   parallel. Any IP missing from ≥1 peer's view is flagged splitBrain:true.
 *
 * loggingEnabled per controller is maintained here and checked by the UDP
 * ingest path before appending / forwarding.
 */

const http = require("http");
const https = require("https");
const fs = require("fs/promises");
const path = require("path");
const dns = require("dns").promises;
const { Bonjour } = require("bonjour-service");
const { setTimeout: delay } = require("node:timers/promises");

// ── SQLite helpers ────────────────────────────────────────────────────────────

function rowToController(row) {
  return {
    ip:               row.ip,
    hostname:         row.hostname,
    deviceId:         row.device_id,
    name:             row.name,
    groups:           JSON.parse(row.groups || "[]"),
    loggingEnabled:   row.logging_enabled !== 0,
    reachable:        row.reachable       !== 0,
    splitBrain:       row.split_brain     !== 0,
    lastSeen:         row.last_seen,
    lastLogReceived:  row.last_log_received,
    soc:              row.soc,
    buildType:        row.build_type,
    gitVersion:       row.git_version,
    smingVersion:     row.sming_version,
    bootNonce:        row.boot_nonce != null ? row.boot_nonce : undefined,
    deviceClass:      "swarm_controller",
  };
}

function controllerToRow(c) {
  return {
    ip:                c.ip,
    hostname:          c.hostname          || null,
    device_id:         c.deviceId          || null,
    name:              c.name              || null,
    groups:            JSON.stringify(c.groups || []),
    logging_enabled:   c.loggingEnabled !== false ? 1 : 0,
    reachable:         c.reachable  ? 1 : 0,
    split_brain:       c.splitBrain ? 1 : 0,
    last_seen:         c.lastSeen          || null,
    last_log_received: c.lastLogReceived    || null,
    soc:               c.soc               || null,
    build_type:        c.buildType         || null,
    git_version:       c.gitVersion        || null,
    sming_version:     c.smingVersion      || null,
    boot_nonce:        c.bootNonce         ?? null,
  };
}

const DEFAULT_PORT = 80;
const REQUEST_TIMEOUT_MS = 5000;
const MISSING_VERSION_RETRY_MS = 60_000;

function isIpv4Address(value) {
  return /^\d+\.\d+\.\d+\.\d+$/.test(String(value || ""));
}

async function discoverWallPanelSeeds(timeoutMs = 1200) {
  return new Promise((resolve) => {
    const discovered = new Set();
    let done = false;
    const browsers = [];

    const finish = (bonjour) => {
      if (done) return;
      done = true;
      try {
        for (const browser of browsers) {
          if (browser) browser.stop();
        }
      } catch {
        // ignore
      }
      try {
        if (bonjour) bonjour.destroy();
      } catch {
        // ignore
      }
      resolve([...discovered]);
    };

    let bonjour;
    try {
      bonjour = new Bonjour();
      const wallPanelTypes = ["wall_panel_api", "wall-panel-api"];
      for (const type of wallPanelTypes) {
        const browser = bonjour.find({ type, protocol: "tcp" }, (service) => {
          for (const addr of service?.addresses || []) {
            if (isIpv4Address(addr)) {
              discovered.add(addr);
            }
          }
          if (service?.host) {
            discovered.add(String(service.host));
          }
          if (isIpv4Address(service?.referer?.address)) {
            discovered.add(service.referer.address);
          }
        });
        browsers.push(browser);
      }
      setTimeout(() => finish(bonjour), timeoutMs);
    } catch {
      finish(bonjour);
    }
  });
}

async function resolveSeedToIpv4(seed) {
  if (!seed) return null;
  if (isIpv4Address(seed)) return String(seed);
  try {
    const result = await dns.lookup(String(seed), { family: 4 });
    return result?.address || null;
  } catch {
    return null;
  }
}

function fetchJson(host, port, requestPath, options = {}) {
  return new Promise((resolve, reject) => {
    const targetUrl = new URL(requestPath, `http://${host}:${port}`);
    const lib = targetUrl.protocol === 'https:' ? https : http;
    
    const reqOptions = {
      hostname: targetUrl.hostname,
      port: targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80),
      path: targetUrl.pathname + targetUrl.search,
      method: options.method || 'GET',
      headers: {
        Accept: 'application/json',
        ...(options.headers || {})
      },
      timeout: REQUEST_TIMEOUT_MS,
    };

    const req = lib.request(reqOptions, (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        const error = new Error(`HTTP ${res.statusCode} from ${targetUrl.hostname}${targetUrl.pathname}`);
        error.statusCode = res.statusCode;
        error.retryAfter = res.headers["retry-after"];
        return reject(error);
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try { 
          resolve(body ? JSON.parse(body) : null); 
        } catch (e) { 
          reject(new Error(`JSON parse error from ${targetUrl.hostname}${targetUrl.pathname}: ${e.message}`)); 
        }
      });
    });

    req.on('timeout', () => { req.destroy(); reject(new Error(`Timeout: ${targetUrl.hostname}${targetUrl.pathname}`)); });
    req.on('error', reject);

    if (options.body) {
      req.write(typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
    }
    req.end();
  });
}

async function fetchJsonWithRetryAfter(host, port, requestPath, options = {}, maxRetries = 3) {
  let retries = 0;
  while (true) {
    try {
      return await fetchJson(host, port, requestPath, options);
    } catch (error) {
      if (error.statusCode !== 429 || retries >= maxRetries) throw error;
      retries++;
      const retryAfter = error.retryAfter;
      const seconds = Number(retryAfter);
      const retryAt = Date.parse(retryAfter);
      const waitMs = retryAfter != null && Number.isFinite(seconds)
        ? Math.max(0, seconds * 1000)
        : (retryAfter && Number.isFinite(retryAt) ? Math.max(0, retryAt - Date.now()) : 1000 * retries);
      console.warn(`Discovery: ${host}${requestPath} returned HTTP 429; retry ${retries}/${maxRetries} in ${Math.ceil(waitMs / 1000)}s`);
      await delay(waitMs);
    }
  }
}

async function fetchFirstJson(host, port, paths) {
  for (const p of paths) {
    try {
      const body = await fetchJsonWithRetryAfter(host, port, p);
      return { body, path: p };
    } catch {
      // try next path
    }
  }
  return null;
}

class ControllerDiscovery {
  /**
   * @param {object} opts
   * @param {string[]} opts.seedHosts          hostnames/IPs to bootstrap from
   * @param {number}   opts.controllerPort     HTTP port of controllers (default 80)
   * @param {number}   opts.refreshIntervalMs  how often to re-query (default 5 min)
   * @param {Function} opts.onUpdate           called with updated controller array
   */
  constructor({
    seedHosts = ["lightinator.local"],
    controllerPort = DEFAULT_PORT,
    refreshIntervalMs = 300_000,
    statePath = null,
    db = null,
    onUpdate = null,
  } = {}) {
    this.seedHosts = seedHosts;
    this.controllerPort = controllerPort;
    this.refreshIntervalMs = refreshIntervalMs;
    this.statePath = statePath;
    this.db = db;
    this.onUpdate = onUpdate;

    /** ip → { hostname, ip, deviceId, name, groups:[{id,name}], loggingEnabled, reachable, lastSeen, lastLogReceived } */
    this.controllers = new Map();

    /** IPs seen via syslog that we haven't resolved yet */
    this.extraSeeds = new Set();
    this.bootNonces = new Map();
    this.bootNumbers = new Map();
    this.infoRequests = new Map();
    this.bootInfoCache = new Map();
    this.versionPollTimers = new Map();

    this._timer = null;
  }

  setBootNonce(ip, bootNonce, bootNumber) {
    if (bootNonce == null) this.bootNonces.delete(ip);
    else this.bootNonces.set(ip, bootNonce);
    if (bootNumber != null) this.bootNumbers.set(ip, bootNumber);
    const controller = this.controllers.get(ip);
    if (controller) this.controllers.set(ip, { ...controller, bootNonce: bootNonce ?? null });
    if (controller && bootNumber != null) this._storeBootInfo(ip, bootNumber, bootNonce, controller, true);
    return this._saveState().then(() => !!controller);
  }

  _bootInfoKey(ip, bootNumber, bootNonce) {
    return `${ip}:${bootNumber ?? `nonce-${bootNonce ?? "unknown"}`}`;
  }

  _storeBootInfo(ip, bootNumber, bootNonce, metadata, onlyIfMissing = false) {
    if (bootNumber == null) return;
    const key = this._bootInfoKey(ip, bootNumber, bootNonce);
    const info = {
      boot_nonce: bootNonce ?? null,
      soc: metadata.soc || null,
      build_type: metadata.buildType || metadata.build_type || null,
      git_version: metadata.gitVersion || metadata.git_version || null,
      sming_version: metadata.smingVersion || metadata.sming_version || null,
    };
    const existing = this.bootInfoCache.get(key);
    if (onlyIfMissing && existing) return;
    if (this.db) {
      const insert = onlyIfMissing ? "INSERT OR IGNORE" : "INSERT";
      const conflict = onlyIfMissing ? "" : `ON CONFLICT (ip, boot) DO UPDATE SET
        boot_nonce = COALESCE(excluded.boot_nonce, controller_boot_info.boot_nonce),
        soc = COALESCE(excluded.soc, controller_boot_info.soc),
        build_type = COALESCE(excluded.build_type, controller_boot_info.build_type),
        git_version = COALESCE(excluded.git_version, controller_boot_info.git_version),
        sming_version = COALESCE(excluded.sming_version, controller_boot_info.sming_version),
        updated_at = excluded.updated_at`;
      this.db.prepare(`${insert} INTO controller_boot_info
        (ip, boot, boot_nonce, soc, build_type, git_version, sming_version, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?) ${conflict}`)
        .run(ip, bootNumber, info.boot_nonce, info.soc, info.build_type, info.git_version, info.sming_version, new Date().toISOString());
      if (onlyIfMissing) {
        const persisted = this.db.prepare(`SELECT soc, build_type, git_version, sming_version, boot_nonce
          FROM controller_boot_info WHERE ip = ? AND boot = ?`).get(ip, bootNumber);
        if (persisted) {
          this.bootInfoCache.set(key, persisted);
          return;
        }
      }
    }
    if (onlyIfMissing && existing) return;
    this.bootInfoCache.set(key, {
      soc: info.soc || existing?.soc || null,
      build_type: info.build_type || existing?.build_type || null,
      git_version: info.git_version || existing?.git_version || null,
      sming_version: info.sming_version || existing?.sming_version || null,
    });
  }

  getBootInfo(ip, bootNumber, bootNonce) {
    if (bootNumber == null && bootNonce == null) return null;
    const key = this._bootInfoKey(ip, bootNumber, bootNonce);
    const cached = this.bootInfoCache.get(key);
    if (cached) return cached;
    if (!this.db) return null;
    let row = bootNumber != null
      ? this.db.prepare(`SELECT soc, build_type, git_version, sming_version, boot_nonce
        FROM controller_boot_info WHERE ip = ? AND boot = ?`).get(ip, bootNumber)
      : this.db.prepare(`SELECT soc, build_type, git_version, sming_version, boot_nonce
        FROM controller_boot_info WHERE ip = ? AND boot_nonce = ? ORDER BY boot DESC LIMIT 1`).get(ip, bootNonce);
    if (!row) {
      row = bootNumber != null
        ? this.db.prepare(`SELECT soc, build_type, git_version, sming_version, boot_nonce FROM logs
          WHERE ip = ? AND boot = ? AND git_version IS NOT NULL ORDER BY id DESC LIMIT 1`).get(ip, bootNumber)
        : this.db.prepare(`SELECT soc, build_type, git_version, sming_version, boot_nonce FROM logs
          WHERE ip = ? AND boot_nonce = ? AND git_version IS NOT NULL ORDER BY id DESC LIMIT 1`).get(ip, bootNonce);
      if (row && bootNumber != null) this._storeBootInfo(ip, bootNumber, row.boot_nonce, row, true);
    }
    if (row) this.bootInfoCache.set(key, row);
    return row || null;
  }

  _fetchControllerInfo(ip, bootNonce, bootNumber) {
    const requestKey = `${ip}:${bootNumber ?? "unknown"}:${bootNonce ?? "unknown"}`;
    const activeRequest = this.infoRequests.get(requestKey);
    if (activeRequest) return activeRequest;

    const request = fetchJsonWithRetryAfter(ip, this.controllerPort, "/info?v=2")
      .finally(() => {
        if (this.infoRequests.get(requestKey) === request) this.infoRequests.delete(requestKey);
      });
    this.infoRequests.set(requestKey, request);
    return request;
  }

  async refreshControllerInfo(ip, expectedBootNonce, expectedBootNumber) {
    try {
      const info = await this._fetchControllerInfo(ip, expectedBootNonce, expectedBootNumber);
      if ((this.bootNonces.get(ip) ?? null) !== (expectedBootNonce ?? null) ||
          this.bootNumbers.get(ip) !== expectedBootNumber) return false;

      const app = info?.app || {};
      const updates = {
        soc: info?.device?.soc ?? info?.soc,
        buildType: app.build_type ?? info?.build_type,
        gitVersion: app.git_version ?? info?.git_version,
        smingVersion: app.sming_git_version ?? app.sming_version ?? info?.sming?.git_version ?? info?.sming?.version ??
          info?.sming_git_version ?? info?.sming_version,
      };
      for (const [key, value] of Object.entries(updates)) {
        if (typeof value !== "string" || !value.trim()) delete updates[key];
      }

      const current = this.controllers.get(ip) || {
      ip,
      hostname: ip,
      deviceId: null,
      name: ip,
      groups: [],
      loggingEnabled: true,
      reachable: true,
      splitBrain: false,
      lastSeen: new Date().toISOString(),
      lastLogReceived: null,
      };
      this.controllers.set(ip, { ...current, ...updates, bootNonce: expectedBootNonce ?? null, reachable: true });
      const updated = this.controllers.get(ip);
      this._storeBootInfo(ip, expectedBootNumber, expectedBootNonce, updated);
      await this._saveState();
      console.info(`Discovery: refreshed /info?v=2 for ${ip}: boot=${expectedBootNumber ?? "unknown"} nonce=${expectedBootNonce ?? "unknown"} firmware=${updates.gitVersion || current.gitVersion || "unknown"} sming=${updates.smingVersion || current.smingVersion || "unknown"}`);
      if (this.onUpdate) this.onUpdate(this.getAll());
      if (updated.gitVersion && updated.soc) this._clearInfoRetry(ip, expectedBootNumber);
      else this._scheduleMissingVersionPoll(ip, expectedBootNonce, expectedBootNumber);
      return true;
    } catch (error) {
      this._scheduleBootInfoRetry(ip, expectedBootNonce, expectedBootNumber, error);
      throw error;
    }
  }

  _infoRetryKey(ip, bootNumber) {
    return `${ip}:${bootNumber ?? "unknown"}`;
  }

  _clearInfoRetry(ip, bootNumber) {
    const key = this._infoRetryKey(ip, bootNumber);
    const timer = this.versionPollTimers.get(key);
    if (timer) clearTimeout(timer);
    this.versionPollTimers.delete(key);
  }

  _scheduleInfoRetry(ip, bootNonce, bootNumber, delayMs) {
    const key = this._infoRetryKey(ip, bootNumber);
    if (this.versionPollTimers.has(key)) return;
    const timer = setTimeout(async () => {
      this.versionPollTimers.delete(key);
      if (this.bootNumbers.get(ip) !== bootNumber ||
          (this.bootNonces.get(ip) ?? null) !== (bootNonce ?? null)) return;
      try {
        await this.refreshControllerInfo(ip, bootNonce, bootNumber);
      } catch (error) {
        console.warn(`Discovery: scheduled /info?v=2 retry failed for ${ip}: ${error.message}`);
        if (!this.versionPollTimers.has(key)) {
          this._scheduleInfoRetry(ip, bootNonce, bootNumber, MISSING_VERSION_RETRY_MS);
        }
      }
    }, Math.max(0, delayMs));
    if (timer.unref) timer.unref();
    this.versionPollTimers.set(key, timer);
  }

  _scheduleMissingVersionPoll(ip, bootNonce = this.bootNonces.get(ip) ?? null, bootNumber = this.bootNumbers.get(ip)) {
    const controller = this.controllers.get(ip);
    if (controller?.gitVersion && controller?.soc) return;
    this._scheduleInfoRetry(ip, bootNonce, bootNumber, MISSING_VERSION_RETRY_MS);
  }

  _scheduleBootInfoRetry(ip, bootNonce, bootNumber, error) {
    const seconds = Number(error.retryAfter);
    const retryAt = Date.parse(error.retryAfter);
    const delayMs = error.retryAfter != null && Number.isFinite(seconds)
      ? Math.max(0, seconds * 1000)
      : (error.retryAfter && Number.isFinite(retryAt) ? Math.max(0, retryAt - Date.now()) : MISSING_VERSION_RETRY_MS);
    this._scheduleInfoRetry(ip, bootNonce, bootNumber, delayMs);
  }

  async _pollMissingControllerVersions(ip) {
    const controller = this.controllers.get(ip);
    if (controller?.gitVersion && controller?.soc) return;
    const bootNonce = this.bootNonces.get(ip) ?? null;
    const bootNumber = this.bootNumbers.get(ip);
    const key = this._infoRetryKey(ip, bootNumber);
    const requestKey = `${ip}:${bootNumber ?? "unknown"}:${bootNonce ?? "unknown"}`;
    if (this.versionPollTimers.has(key) || this.infoRequests.has(requestKey)) return;
    try {
      await this.refreshControllerInfo(ip, bootNonce, bootNumber);
    } catch (error) {
      console.debug(`Discovery: initial version lookup failed for ${ip}: ${error.message}`);
      if (!this.versionPollTimers.has(key)) {
        this._scheduleInfoRetry(ip, bootNonce, bootNumber, MISSING_VERSION_RETRY_MS);
      }
    }
  }

  /** Called by UDP ingest when a syslog packet arrives from a new IP */
  addSeenIp(ip) {
    if (!this.controllers.has(ip) && !this.extraSeeds.has(ip)) {
      this.extraSeeds.add(ip);
      this.refresh().catch(() => {});
    }
  }

  /** Called by UDP ingest to record when a log message was received from a controller */
  recordLogReceived(ip) {
    const c = this.controllers.get(ip);
    if (c) {
      this.controllers.set(ip, { ...c, lastLogReceived: new Date().toISOString() });
    }
  }

  start({ loadState = true } = {}) {
    (loadState ? this._loadState() : Promise.resolve()).then(() => {
      this.refresh().catch(() => {});
    });
    if (this.refreshIntervalMs > 0) {
      this._timer = setInterval(() => this.refresh().catch(() => {}), this.refreshIntervalMs);
      if (this._timer.unref) this._timer.unref();
    }
  }

  stop() {
    clearInterval(this._timer);
    this._timer = null;
    for (const timer of this.versionPollTimers.values()) clearTimeout(timer);
    this.versionPollTimers.clear();
  }

  async refresh() {
    const mdnsSeeds = await discoverWallPanelSeeds();
    const resolvedMdnsIps = await Promise.all(mdnsSeeds.map((s) => resolveSeedToIpv4(s)));
    const mdnsWallPanelIps = new Set([
      ...mdnsSeeds.filter(isIpv4Address),
      ...resolvedMdnsIps.filter(Boolean),
    ]);

    const allSeeds = [
      ...this.seedHosts,
      ...this.extraSeeds,
      ...[...this.controllers.keys()],
      ...mdnsSeeds,
      ...resolvedMdnsIps.filter(Boolean),
    ];

    let hostsData = null;
    let appData = null;
    let sourceHost = null;

    for (const host of allSeeds) {
      try {
        [hostsData, appData] = await Promise.all([
          fetchJson(host, this.controllerPort, "/hosts?all=true"),
          fetchJson(host, this.controllerPort, "/data"),
        ]);
        sourceHost = host;
        break;
      } catch {
        // try next seed
      }
    }

    if (!hostsData || !appData) {
      console.debug("Discovery: no reachable swarm seed found, using mDNS/syslog-only mode");
    }

    // Build group membership: data.controller id → [{id,name}]
    const groupsByControllerId = new Map();
    if (appData) {
      for (const g of appData.groups || []) {
        for (const cid of g.controller_ids || []) {
          const key = String(cid);
          if (!groupsByControllerId.has(key)) groupsByControllerId.set(key, []);
          groupsByControllerId.get(key).push({ id: g.id, name: g.name });
        }
      }
    }

    // Build ip → data.controller.id map using the "ip-address" field
    const ipToDataId = new Map();
    const ipToDataName = new Map();
    if (appData) {
      for (const c of appData.controllers || []) {
        const ip = c["ip-address"];
        if (ip) {
          ipToDataId.set(ip, String(c.id));
          ipToDataName.set(ip, c.name);
        }
      }
    }

    const updatedIps = new Set();
    if (hostsData) {
      for (const h of hostsData.hosts || []) {
        const ip = h.ip_address;
        if (!ip) continue;

        const dataId = ipToDataId.get(ip);
        const groups = dataId ? (groupsByControllerId.get(dataId) || []) : [];
        const name = ipToDataName.get(ip) || h.hostname;
        const existing = this.controllers.get(ip) || {};
        const deviceClass = (existing.deviceClass === "wall_panel" || mdnsWallPanelIps.has(ip))
          ? "wall_panel"
          : "swarm_controller";

        this.controllers.set(ip, {
          hostname: h.hostname,
          ip,
          deviceId: String(h.id),
          name,
          deviceClass,
          groups,
          loggingEnabled: existing.loggingEnabled !== undefined ? existing.loggingEnabled : true,
          reachable: true,
          splitBrain: false,
          lastSeen: new Date().toISOString(),
          lastLogReceived: existing.lastLogReceived || null,
          // Preserve fields fetched from /info?v=2 so they survive refresh cycles
          // where the per-controller /info fetch might be slow or temporarily fail.
          soc:        existing.soc,
          buildType:  existing.buildType,
          gitVersion: existing.gitVersion,
          smingVersion: existing.smingVersion,
          bootNonce: existing.bootNonce,
        });
        updatedIps.add(ip);
        this.extraSeeds.delete(ip); // promoted to known
      }
    }

    // mDNS-only wall panel upsert: no HTTP API required.
    for (const ip of mdnsWallPanelIps) {
      const existing = this.controllers.get(ip) || {};
      this.controllers.set(ip, {
        hostname: existing.hostname || ip,
        ip,
        deviceId: existing.deviceId || null,
        name: existing.name || `wall-panel-${ip.split(".").pop()}`,
        deviceClass: "wall_panel",
        groups: existing.groups || [],
        loggingEnabled: existing.loggingEnabled !== undefined ? existing.loggingEnabled : true,
        reachable: true,
        splitBrain: false,
        lastSeen: new Date().toISOString(),
        lastLogReceived: existing.lastLogReceived || null,
        soc: existing.soc,
        buildType: existing.buildType,
        gitVersion: existing.gitVersion,
        smingVersion: existing.smingVersion,
        bootNonce: existing.bootNonce,
      });
      updatedIps.add(ip);
      this.extraSeeds.delete(ip);
    }

    // Fallback discovery for standalone wall panels without polling firmware metadata.
    const fallbackCandidates = allSeeds.filter((host) => {
      if (!host) return false;
      if (updatedIps.has(host)) return false;
      const existing = this.controllers.get(host);
      return !(existing && existing.deviceClass === "swarm_controller") &&
        (!existing || existing.deviceClass === "wall_panel");
    });

    for (const host of fallbackCandidates) {
      const cfgResult = await fetchFirstJson(host, this.controllerPort, ["/config"]);
      if (!cfgResult) continue;
      const cfg = cfgResult?.body || {};

      const ip = host;
      const existing = this.controllers.get(ip) || {};
      const loggingEnabled = cfg?.network?.rsyslog?.enabled;

      this.controllers.set(ip, {
        hostname: existing.hostname || ip,
        ip,
        deviceId: existing.deviceId || null,
        name: existing.name || ip,
        deviceClass: "wall_panel",
        groups: existing.groups || [],
        loggingEnabled: loggingEnabled !== undefined
          ? !!loggingEnabled
          : (existing.loggingEnabled !== undefined ? existing.loggingEnabled : true),
        reachable: true,
        splitBrain: false,
        lastSeen: new Date().toISOString(),
        lastLogReceived: existing.lastLogReceived || null,
        soc: existing.soc,
        buildType: existing.buildType,
        gitVersion: existing.gitVersion,
        smingVersion: existing.smingVersion,
        bootNonce: existing.bootNonce,
      });
      updatedIps.add(ip);
      this.extraSeeds.delete(ip);
    }

    // Mark controllers no longer in /hosts?all=true as unreachable (keep for history)
    for (const [ip, entry] of this.controllers) {
      if (!updatedIps.has(ip)) {
        this.controllers.set(ip, { ...entry, reachable: false });
      }
    }

    console.log(
      `Discovery: ${updatedIps.size} node(s) via ${sourceHost || "fallback"}: ` +
      [...updatedIps].join(", "),
    );

    // ── Split-brain detection ─────────────────────────────────────────────────
    // Query /hosts?all=true on every reachable controller in parallel.
    // Any IP that is absent from ≥1 peer's view is a split-brain candidate.
    const reachableIps = [...updatedIps];
    if (reachableIps.length > 1) {
      const peerViews = await Promise.all(
        reachableIps.map(async (ip) => {
          try {
            const d = await fetchJson(ip, this.controllerPort, "/hosts?all=true");
            return { ip, known: new Set((d.hosts || []).map(h => h.ip_address).filter(Boolean)) };
          } catch {
            return { ip, known: null }; // unreachable peer — skip
          }
        }),
      );

      const reachableViews = peerViews.filter(v => v.known !== null);
      for (const [ip, entry] of this.controllers) {
        if (!entry.reachable) continue;
        // a controller is split-brain if any peer that responded doesn't list it
        const missing = reachableViews.some(v => v.ip !== ip && !v.known.has(ip));
        if (missing !== entry.splitBrain) {
          this.controllers.set(ip, { ...entry, splitBrain: missing });
          if (missing) console.warn(`Discovery: split-brain detected for ${ip}`);
        }
      }

      const splitCount = [...this.controllers.values()].filter(c => c.splitBrain).length;
      if (splitCount > 0) {
        console.warn(`Discovery: ${splitCount} controller(s) have split-brain visibility`);
      }
    }

    // Refresh rsyslog.enabled without polling firmware version metadata.
    await Promise.all(
      reachableIps.map(async (ip) => {
        try {
          const requestedBootNonce = this.bootNonces.get(ip);
          const cfg = await fetchJson(ip, this.controllerPort, "/config")
            .catch((e) => { console.debug(`Discovery: /config failed for ${ip}: ${e.message}`); return null; });
          const entry = this.controllers.get(ip);
          if (!entry || this.bootNonces.get(ip) !== requestedBootNonce) return;
          const updates = {};
          const enabled = cfg?.network?.rsyslog?.enabled ?? null;
          if (enabled !== null) updates.loggingEnabled = enabled;
          if (Object.keys(updates).length) {
            this.controllers.set(ip, { ...entry, ...updates });
          }
        } catch (e) {
          console.debug(`Discovery: per-controller fetch error for ${ip}: ${e.message}`);
        }
      }),
    );

    await this._saveState();

    await Promise.all([...updatedIps].map(ip => this._pollMissingControllerVersions(ip)));

    if (this.onUpdate) this.onUpdate(this.getAll());
  }

  getAll() {
    return Array.from(this.controllers.values());
  }

  async _loadState() {
    if (this.db) {
      // ── SQLite path ──────────────────────────────────────────────────────
      const rows = this.db.prepare("SELECT * FROM controllers").all();
      if (rows.length > 0) {
        for (const row of rows) {
          const controller = { ...rowToController(row), reachable: false };
          this.controllers.set(row.ip, controller);
          if (controller.bootNonce != null) this.bootNonces.set(row.ip, controller.bootNonce);
        }
        console.log(`Discovery: loaded ${rows.length} persisted controller(s)`);
        return;
      }

      // Empty DB — attempt one-time migration from legacy controllers.json
      if (this.statePath) {
        try {
          const raw = await fs.readFile(this.statePath, "utf8");
          const arr = JSON.parse(raw);
          const upsert = this.db.prepare(`
            INSERT OR REPLACE INTO controllers
              (ip, hostname, device_id, name, groups, logging_enabled, reachable,
               split_brain, last_seen, last_log_received, soc, build_type, git_version, sming_version, boot_nonce)
            VALUES
              (@ip, @hostname, @device_id, @name, @groups, @logging_enabled, @reachable,
               @split_brain, @last_seen, @last_log_received, @soc, @build_type, @git_version, @sming_version, @boot_nonce)
          `);
          const importAll = this.db.transaction((entries) => {
            for (const e of entries) upsert.run(controllerToRow(e));
          });
          importAll(arr);
          for (const entry of arr) {
            this.controllers.set(entry.ip, { ...entry, reachable: false });
            if (entry.bootNonce != null) this.bootNonces.set(entry.ip, entry.bootNonce);
          }
          console.log(`Discovery: migrated ${arr.length} controller(s) from controllers.json`);
        } catch {
          // No JSON file — first run
        }
      }
      return;
    }

    // ── Legacy file-only path (no db passed) ─────────────────────────────
    if (!this.statePath) return;
    try {
      const raw = await fs.readFile(this.statePath, "utf8");
      const arr = JSON.parse(raw);
      for (const entry of arr) {
        this.controllers.set(entry.ip, { ...entry, reachable: false });
        if (entry.bootNonce != null) this.bootNonces.set(entry.ip, entry.bootNonce);
      }
      console.log(`Discovery: loaded ${arr.length} persisted controller(s)`);
    } catch {
      // no state file yet — first run
    }
  }

  _saveState() {
    if (this.db) {
      try {
        const upsert = this.db.prepare(`
          INSERT OR REPLACE INTO controllers
            (ip, hostname, device_id, name, groups, logging_enabled, reachable,
             split_brain, last_seen, last_log_received, soc, build_type, git_version, sming_version, boot_nonce)
          VALUES
            (@ip, @hostname, @device_id, @name, @groups, @logging_enabled, @reachable,
             @split_brain, @last_seen, @last_log_received, @soc, @build_type, @git_version, @sming_version, @boot_nonce)
        `);
        const saveAll = this.db.transaction((entries) => {
          for (const e of entries) upsert.run(controllerToRow(e));
        });
        saveAll(Array.from(this.controllers.values()));
      } catch (e) {
        console.warn(`Discovery: failed to save state to SQLite: ${e.message}`);
      }
      return Promise.resolve();
    }

    // Legacy JSON fallback
    if (!this.statePath) return Promise.resolve();
    return fs.mkdir(path.dirname(this.statePath), { recursive: true })
      .then(() => fs.writeFile(
        this.statePath,
        JSON.stringify(Array.from(this.controllers.values()), null, 2),
        "utf8",
      ))
      .catch((e) => console.warn(`Discovery: failed to save state: ${e.message}`));
  }

  setLogging(ip, enabled) {
    const c = this.controllers.get(ip);
    if (!c) return false;
    this.controllers.set(ip, { ...c, loggingEnabled: !!enabled });
    return true;
  }

  /** Remove a controller from memory and the DB. Returns false if unknown. */
  remove(ip) {
    const existed = this.controllers.delete(ip);
    this.extraSeeds.delete(ip);
    if (this.db) {
      try {
        this.db.prepare("DELETE FROM controllers WHERE ip = ?").run(ip);
      } catch (e) {
        console.warn(`Discovery: failed to delete ${ip} from SQLite: ${e.message}`);
      }
    }
    return existed;
  }

  /**
   * IPs of controllers whose last activity (max of lastSeen and lastLogReceived,
   * null counts as never) is older than `days` days.
   */
  listStale(days) {
    const cutoff = Date.now() - Number(days) * 86_400_000;
    const toTime = (iso) => {
      const t = iso ? new Date(iso).getTime() : NaN;
      return Number.isFinite(t) ? t : -Infinity;
    };
    const stale = [];
    for (const [ip, c] of this.controllers) {
      const last = Math.max(toTime(c.lastSeen), toTime(c.lastLogReceived));
      if (last < cutoff) stale.push(ip);
    }
    return stale;
  }

  /** Returns false only when we explicitly know this IP has logging disabled */
  isLoggingEnabled(ip) {
    const c = this.controllers.get(ip);
    if (!c) return true; // unknown → allow, so we never silently drop logs
    return c.loggingEnabled !== false;
  }

  /** Group names for this IP, used as Loki labels */
  getGroupsForIp(ip) {
    return (this.controllers.get(ip) || {}).groups || [];
  }
}

module.exports = { ControllerDiscovery };
