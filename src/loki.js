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
  }

  async loadConfig() {
    try {
      const raw = await fs.readFile(this.configPath, "utf8");
      const parsed = JSON.parse(raw);
      this.config = { ...DEFAULT_CONFIG, ...parsed };
      console.log(`Loki: config loaded (enabled=${this.config.enabled}, url=${this.config.url})`);
    } catch (err) {
      if (err.code !== "ENOENT") {
        console.warn("Loki: failed to read config:", err.message);
      }
    }
    this._restartTimer();
  }

  async saveConfig(incoming) {
    const updated = { ...DEFAULT_CONFIG, ...this.config };
    for (const key of Object.keys(incoming)) {
      // Sentinel value means "keep existing password"
      if (key === "password" && incoming.password === MASK) continue;
      updated[key] = incoming[key];
    }
    this.config = updated;
    await fs.writeFile(this.configPath, JSON.stringify(this.config, null, 2), "utf8");
    this._restartTimer();
    console.log(`Loki: config saved (enabled=${this.config.enabled}, url=${this.config.url})`);
  }

  getConfig() {
    return {
      ...this.config,
      password: this.config.password ? MASK : "",
    };
  }

  _restartTimer() {
    clearInterval(this._timer);
    this._timer = null;
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
    } catch (err) {
      console.warn(`Loki: push failed (${batch.length} records dropped):`, err.message);
    } finally {
      this._sending = false;
    }
  }

  _buildPayload(records) {
    const streams = new Map();
    for (const r of records) {
      const streamKey = {
        ...this.config.labels,
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

  _push(records) {
    return new Promise((resolve, reject) => {
      let baseUrl;
      try {
        baseUrl = new URL(this.config.url);
      } catch {
        return reject(new Error(`Invalid Loki URL: ${this.config.url}`));
      }

      const payload = JSON.stringify(this._buildPayload(records));
      const isHttps = baseUrl.protocol === "https:";
      const lib = isHttps ? https : http;

      const headers = {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
      };
      if (this.config.username && this.config.password) {
        headers["Authorization"] =
          "Basic " + Buffer.from(`${this.config.username}:${this.config.password}`).toString("base64");
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
          res.statusCode >= 400
            ? reject(new Error(`Loki returned HTTP ${res.statusCode}`))
            : resolve();
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

  async testConnection() {
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
    ]);
  }

  stop() {
    clearInterval(this._timer);
    this._timer = null;
  }
}

module.exports = { LokiForwarder };
