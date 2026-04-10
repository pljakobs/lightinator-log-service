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

const DEFAULT_PORT = 80;
const REQUEST_TIMEOUT_MS = 5000;

function fetchJson(host, port, path) {
  return new Promise((resolve, reject) => {
    const lib = http;
    const req = lib.get(
      {
        hostname: host,
        port,
        path,
        headers: { Accept: "application/json" },
        timeout: REQUEST_TIMEOUT_MS,
      },
      (res) => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} from ${host}${path}`));
        }
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          try { resolve(JSON.parse(body)); }
          catch (e) { reject(new Error(`JSON parse error from ${host}${path}: ${e.message}`)); }
        });
      },
    );
    req.on("timeout", () => { req.destroy(); reject(new Error(`Timeout: ${host}${path}`)); });
    req.on("error", reject);
  });
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
    onUpdate = null,
  } = {}) {
    this.seedHosts = seedHosts;
    this.controllerPort = controllerPort;
    this.refreshIntervalMs = refreshIntervalMs;
    this.statePath = statePath;
    this.onUpdate = onUpdate;

    /** ip → { hostname, ip, deviceId, name, groups:[{id,name}], loggingEnabled, reachable, lastSeen, lastLogReceived } */
    this.controllers = new Map();

    /** IPs seen via syslog that we haven't resolved yet */
    this.extraSeeds = new Set();

    this._timer = null;
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

  start() {
    this._loadState().then(() => {
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
  }

  async refresh() {
    const allSeeds = [...this.seedHosts, ...this.extraSeeds];

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
      console.debug("Discovery: no reachable seed found");
      return;
    }

    // Build group membership: data.controller id → [{id,name}]
    const groupsByControllerId = new Map();
    for (const g of appData.groups || []) {
      for (const cid of g.controller_ids || []) {
        const key = String(cid);
        if (!groupsByControllerId.has(key)) groupsByControllerId.set(key, []);
        groupsByControllerId.get(key).push({ id: g.id, name: g.name });
      }
    }

    // Build ip → data.controller.id map using the "ip-address" field
    const ipToDataId = new Map();
    const ipToDataName = new Map();
    for (const c of appData.controllers || []) {
      const ip = c["ip-address"];
      if (ip) {
        ipToDataId.set(ip, String(c.id));
        ipToDataName.set(ip, c.name);
      }
    }

    const updatedIps = new Set();
    for (const h of hostsData.hosts || []) {
      const ip = h.ip_address;
      if (!ip) continue;

      const dataId = ipToDataId.get(ip);
      const groups = dataId ? (groupsByControllerId.get(dataId) || []) : [];
      const name = ipToDataName.get(ip) || h.hostname;
      const existing = this.controllers.get(ip) || {};

      this.controllers.set(ip, {
        hostname: h.hostname,
        ip,
        deviceId: String(h.id),
        name,
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
      });
      updatedIps.add(ip);
      this.extraSeeds.delete(ip); // promoted to known
    }

    // Mark controllers no longer in /hosts?all=true as unreachable (keep for history)
    for (const [ip, entry] of this.controllers) {
      if (!updatedIps.has(ip)) {
        this.controllers.set(ip, { ...entry, reachable: false });
      }
    }

    console.log(
      `Discovery: ${updatedIps.size} controller(s) via ${sourceHost}: ` +
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

    // ── Fetch actual rsyslog.enabled from each reachable controller's /config ──
    // This reflects the real firmware state rather than an in-memory shadow.
    await Promise.all(
      reachableIps.map(async (ip) => {
        try {
          const [cfg, info] = await Promise.all([
            fetchJson(ip, this.controllerPort, "/config").catch((e) => { console.debug(`Discovery: /config failed for ${ip}: ${e.message}`); return null; }),
            fetchJson(ip, this.controllerPort, "/info?v=2").catch((e) => { console.debug(`Discovery: /info?v=2 failed for ${ip}: ${e.message}`); return null; }),
          ]);
          const entry = this.controllers.get(ip);
          if (!entry) return;
          const updates = {};
          const enabled = cfg?.network?.rsyslog?.enabled ?? null;
          if (enabled !== null) updates.loggingEnabled = enabled;
          // /info?v=2 returns nested structure: { device: { soc }, app: { build_type, git_version } }
          // Older firmware that doesn't recognise the v param returns a flat structure:
          // { soc, build_type, git_version } — fall back to root-level fields in that case.
          if (info?.device?.soc)       updates.soc        = info.device.soc;
          else if (info?.soc)          updates.soc        = info.soc;
          if (info?.app?.build_type)   updates.buildType  = info.app.build_type;
          else if (info?.build_type)   updates.buildType  = info.build_type;
          if (info?.app?.git_version)  updates.gitVersion = info.app.git_version;
          else if (info?.git_version)  updates.gitVersion = info.git_version;
          console.debug(`Discovery: /info?v=2 for ${ip}: ${info ? `soc=${info.device?.soc ?? info.soc} build=${info.app?.build_type ?? info.build_type} ver=${info.app?.git_version ?? info.git_version}` : "null"}`);
          if (Object.keys(updates).length) {
            this.controllers.set(ip, { ...entry, ...updates });
          }
        } catch (e) {
          console.debug(`Discovery: per-controller fetch error for ${ip}: ${e.message}`);
        }
      }),
    );

    await this._saveState();

    if (this.onUpdate) this.onUpdate(this.getAll());
  }

  getAll() {
    return Array.from(this.controllers.values());
  }

  async _loadState() {
    if (!this.statePath) return;
    try {
      const raw = await fs.readFile(this.statePath, "utf8");
      const arr = JSON.parse(raw);
      for (const entry of arr) {
        // Mark all as offline until next refresh confirms them
        this.controllers.set(entry.ip, { ...entry, reachable: false });
      }
      console.log(`Discovery: loaded ${arr.length} persisted controller(s)`);
    } catch {
      // no state file yet — first run
    }
  }

  async _saveState() {
    if (!this.statePath) return;
    try {
      await fs.mkdir(path.dirname(this.statePath), { recursive: true });
      await fs.writeFile(
        this.statePath,
        JSON.stringify(Array.from(this.controllers.values()), null, 2),
        "utf8",
      );
    } catch (e) {
      console.warn(`Discovery: failed to save state: ${e.message}`);
    }
  }

  setLogging(ip, enabled) {
    const c = this.controllers.get(ip);
    if (!c) return false;
    this.controllers.set(ip, { ...c, loggingEnabled: !!enabled });
    return true;
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
