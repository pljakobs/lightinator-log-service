const fs = require("fs/promises");
const http = require("http");
const https = require("https");

const MASK = "••••••••";

const DEFAULT_CONFIG = {
  enabled: false,
  url: "http://localhost:3100",
  username: "",
  password: "",
  labels: { job: "lightinator" },
  // groups: { groupName: { labelKey: labelValue, ... } }
  groups: {},
  // controllers: { ip: { labels: { labelKey: labelValue }, group: "groupName" } }
  controllers: {},
  batchSize: 100,
  flushIntervalMs: 5000,
};

class LokiForwarder {
  constructor({ configPath }) {
    this.configPath = configPath;
    this.config = { ...DEFAULT_CONFIG };
    this._buffer = [];
    this._timer = null;
    this._sending = false;
    this._status = { state: 'disabled', lastPushAt: null, lastError: null, pushed: 0 };
  }

  getStatus() {
    return { ...this._status };
  }

  async loadConfig() {
    try {
      const raw = await fs.readFile(this.configPath, "utf8");
      const parsed = JSON.parse(raw);
      const legacyUrl = new URL(parsed.url || DEFAULT_CONFIG.url);
      const migrated = { ...parsed };
      const migrationNeeded = Boolean(legacyUrl.username || legacyUrl.password);
      if (migrationNeeded) {
        migrated.username = parsed.username || decodeURIComponent(legacyUrl.username);
        migrated.password = parsed.password || decodeURIComponent(legacyUrl.password);
        legacyUrl.username = "";
        legacyUrl.password = "";
        migrated.url = legacyUrl.href;
      }
      if (migrated.password != null && typeof migrated.password !== "string") throw new Error("Invalid saved password");
      this.config = { ...this._withOverrides({ ...migrated, password: null }), password: migrated.password || "" };
      if (migrationNeeded) {
        const backup = this.configPath + ".pre-write-only.bak";
        const temporary = this.configPath + `.migration-${process.pid}.tmp`;
        try {
          try { await fs.writeFile(backup, raw, { encoding: "utf8", mode: 0o600, flag: "wx" }); }
          catch (error) { if (error.code !== "EEXIST") throw error; }
          await fs.chmod(backup, 0o600);
          await fs.writeFile(temporary, JSON.stringify(migrated, null, 2), { encoding: "utf8", mode: 0o600 });
          await fs.rename(temporary, this.configPath);
        } catch {
          await fs.unlink(temporary).catch(() => {});
          console.warn("Loki: using migrated credentials in memory; migration could not be persisted.");
        }
      }
      console.log(`Loki: config loaded (enabled=${this.config.enabled}, url=${this.config.url})`);
    } catch (err) {
      if (err.code !== "ENOENT") {
        console.warn("Loki: failed to load saved configuration; check the configuration file.");
      }
    }
    this._restartTimer();
  }

  async saveConfig(incoming) {
    const updated = this._withOverrides(incoming);
    await fs.writeFile(this.configPath, JSON.stringify(updated, null, 2), { encoding: "utf8", mode: 0o600 });
    await fs.chmod(this.configPath, 0o600);
    this.config = updated;
    this._restartTimer();
    console.log(`Loki: config saved (enabled=${this.config.enabled}, url=${this.config.url})`);
  }

  getConfig() {
    return {
      ...Object.fromEntries(Object.keys(DEFAULT_CONFIG).filter(key => key !== "password").map(key => [key, this.config[key]])),
      passwordConfigured: Boolean(this.config.password),
    };
  }

  _withOverrides(incoming = {}) {
    if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) {
      throw Object.assign(new Error("Invalid Loki settings"), { status: 400 });
    }
    const updated = { ...this.config };
    for (const key of Object.keys(DEFAULT_CONFIG)) {
      if (!Object.hasOwn(incoming, key) || incoming[key] === undefined) continue;
      if (key === "password") {
        if (incoming.password === "" || incoming.password === MASK) continue;
        if (incoming.password !== null && typeof incoming.password !== "string") {
          throw Object.assign(new Error("Invalid Loki password"), { status: 400 });
        }
        updated.password = incoming.password ?? "";
      } else {
        updated[key] = incoming[key];
      }
    }
    let target;
    try {
      target = new URL(updated.url);
    } catch {
      throw Object.assign(new Error("Invalid Loki URL"), { status: 400 });
    }
    if (!["http:", "https:"].includes(target.protocol) || target.username || target.password) {
      throw Object.assign(new Error("Loki URL must use HTTP(S) without embedded credentials"), { status: 400 });
    }
    const destinationChanged = target.href !== new URL(this.config.url).href || updated.username !== this.config.username;
    const passwordChanged = incoming.password === null ||
      (typeof incoming.password === "string" && incoming.password !== "" && incoming.password !== MASK);
    if (this.config.password && destinationChanged && !passwordChanged) {
      throw Object.assign(new Error("Changing Loki URL or username requires replacing or clearing the password"), { status: 400 });
    }
    return updated;
  }

  _restartTimer() {
    clearInterval(this._timer);
    this._timer = null;
    if (!this.config.enabled) this._status = { ...this._status, state: 'disabled' };
    if (!this.config.enabled || !(this.config.flushIntervalMs > 0)) return;
    this._timer = setInterval(() => {
      this._flush().catch(() => {});
    }, this.config.flushIntervalMs);
    if (this._timer.unref) this._timer.unref();
  }

  forward(record) {
    if (!this.config.enabled) return;
    this._buffer.push(record);
    if (this._buffer.length >= (this.config.batchSize || 100)) {
      this._flush().catch(() => {});
    }
  }

  async _flush() {
    if (!this.config.enabled || this._buffer.length === 0 || this._sending) return;
    const batch = this._buffer.splice(0);
    this._sending = true;
    try {
      await this._push(batch);
      this._status = { state: 'ok', lastPushAt: new Date().toISOString(), lastError: null, pushed: (this._status.pushed || 0) + batch.length };
    } catch (err) {
      console.warn(`Loki: push failed (${batch.length} records dropped):`, err.message);
      this._status = { ...this._status, state: 'error', lastError: err.message };
    } finally {
      this._sending = false;
    }
  }

  _resolveLabels(sourceIp, pushConfig = this.config) {
    const global = { ...(pushConfig.labels || {}) };
    const controllerCfg = (pushConfig.controllers || {})[sourceIp] || {};
    const groupName = controllerCfg.group || "";
    const groupLabels = groupName ? (pushConfig.groups || {})[groupName] || {} : {};
    const controllerLabels = controllerCfg.labels || {};
    return { ...global, ...groupLabels, ...controllerLabels };
  }

  _buildPayload(records, pushConfig = this.config) {
    const streams = new Map();
    for (const r of records) {
      const streamKey = {
        ...this._resolveLabels(r.sourceIp || "unknown", pushConfig),
        host: r.tag || r.sourceIp || "unknown",
        source_ip: r.sourceIp || "unknown",
        tag: r.tag || "unknown",
      };
      const key = JSON.stringify(streamKey);
      if (!streams.has(key)) streams.set(key, { stream: streamKey, values: [] });
      // Loki expects nanosecond timestamps as strings
      const tsNs = String(BigInt(new Date(r.receivedAt || Date.now()).getTime()) * 1_000_000n);
      streams.get(key).values.push([tsNs, r.message || r.raw || ""]);
    }
    return { streams: Array.from(streams.values()) };
  }

  _push(records, pushConfig = this.config) {
    return new Promise((resolve, reject) => {
      let baseUrl;
      try {
        baseUrl = new URL(pushConfig.url);
      } catch {
        return reject(new Error("Invalid Loki URL"));
      }

      const payload = JSON.stringify(this._buildPayload(records, pushConfig));
      const isHttps = baseUrl.protocol === "https:";
      const lib = isHttps ? https : http;

      const headers = {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
      };
      if (pushConfig.username && pushConfig.password) {
        headers["Authorization"] =
          "Basic " + Buffer.from(`${pushConfig.username}:${pushConfig.password}`).toString("base64");
      }

      const req = lib.request(
        {
          hostname: baseUrl.hostname,
          port: baseUrl.port || (isHttps ? 443 : 80),
          path: "/loki/api/v1/push",
          method: "POST",
          headers,
          timeout: 10_000,
        },
        (res) => {
          res.resume();
          res.on("end", () => {
            if (res.statusCode >= 400) {
              reject(new Error(`Loki returned HTTP ${res.statusCode}`));
            } else {
              resolve();
            }
          });
        },
      );

      req.on("timeout", () => {
        req.destroy();
        reject(new Error("Request timed out"));
      });
      req.on("error", reject);
      req.write(payload);
      req.end();
    });
  }

  async testConnection(overrideConfig = null) {
    const effectiveConfig = this._withOverrides(overrideConfig || {});
    await this._push([
      {
        id: "lls-test",
        receivedAt: new Date().toISOString(),
        sourceIp: "127.0.0.1",
        priority: 6,
        tag: "LLS",
        app: "LightinatorLogService",
        deviceTime: null,
        message: "Loki connection test from Lightinator Log Service",
        raw: "",
      },
    ], effectiveConfig);
  }

  stop() {
    clearInterval(this._timer);
    this._timer = null;
  }
}

module.exports = { LokiForwarder };
