/**
 * crashDecoder.js
 *
 * Detects crash dump lines arriving via syslog, resolves matching target ELF
 * using version metadata registered from alive controllers (or live HTTP fallback),
 * runs the Sming stacktrace decoder, and emits the decoded log record.
 */

"use strict";

const { spawn } = require("child_process");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const http = require("http");
const https = require("https");

const CRASH_TRIGGER_RE = /pc=0x[0-9a-f]+ +sp=0x[0-9a-f]+ +excvaddr=0x[0-9a-f]+/i;

const SOC_CONFIG = {
  esp8266: {
    script:    path.join(__dirname, "../tools/decode-esp8266.py"),
    elfFile:   "app_0.out",
    smingArch: "Esp8266",
    smingSOC:  "esp8266",
  },
  esp32: {
    script:    path.join(__dirname, "../tools/decode-esp32.py"),
    elfFile:   "app.out",
    smingArch: "Esp32",
    smingSOC:  "esp32",
  },
  esp32c3: {
    script:    path.join(__dirname, "../tools/decode-esp32.py"),
    elfFile:   "app.out",
    smingArch: "Esp32",
    smingSOC:  "esp32c3",
  },
};

class CrashDecoder {
  /**
   * @param {object} opts
   * @param {string}              opts.elfCacheDir Directory where ELF files are cached
   * @param {string}              opts.elfBaseUrl  Base URL for ELF downloads
   * @param {ControllerDiscovery} [opts.discovery] ControllerDiscovery instance tracking active nodes
   * @param {Function}            opts.onDecoded   Called with decoded log record
   */
  constructor({ elfCacheDir, elfBaseUrl, discovery = null, onDecoded }) {
    this.elfCacheDir = elfCacheDir;
    this.elfBaseUrl  = elfBaseUrl;
    this.discovery   = discovery;
    this.onDecoded   = onDecoded;

    // ip → { lines: string[], inStack: boolean }
    this._collecting = new Map();
  }

  feed(record) {
    const msg = (record.message || "").trimEnd();
    const ip  = record.sourceIp;

    if (CRASH_TRIGGER_RE.test(msg)) {
      this._collecting.set(ip, { lines: [], inStack: false });
    }

    const state = this._collecting.get(ip);
    if (!state) return false;

    state.lines.push(msg);

    if (msg === "Stack dump:") {
      state.inStack = true;
      return true;
    }

    if (state.inStack && msg.trim() === "") {
      this._collecting.delete(ip);
      const capturedLines = state.lines;
      setImmediate(() => {
        this._decode(ip, record, capturedLines).catch(e => {
          console.warn(`CrashDecoder [${ip}]: decode failed — ${e.message}`);
        });
      });
      return true;
    }

    return true;
  }

  // ── Private Methods ────────────────────────────────────────────────────────

  async _resolveTargetInfo(ip) {
    // 1. Try resolving target version from Discovery memory cache
    if (this.discovery) {
      const known = this.discovery.controllers.get(ip);
      if (known?.gitVersion && known?.soc) {
        return {
          git_version: known.gitVersion,
          soc:         known.soc,
          build_type:  known.buildType || "debug",
        };
      }
    }

    // 2. Fall back to live /info?v=2 endpoint directly if node is reachable
    return await this._fetchFirmwareInfo(ip);
  }

  async _decode(ip, triggerRecord, lines) {
    const info = await this._resolveTargetInfo(ip);
    if (!info || !info.git_version || !info.soc) {
      console.warn(`CrashDecoder [${ip}]: target metadata missing (git_version/soc) — skipping decode`);
      return;
    }

    const { git_version, soc, build_type } = info;
    const socKey = soc.toLowerCase();
    const cfg    = SOC_CONFIG[socKey];

    if (!cfg) {
      console.warn(`CrashDecoder [${ip}]: unsupported SOC "${soc}" — skipping decode`);
      return;
    }

    // Parse branch from version string: "V5.0-{build}-{branch}"
    const vMatch = git_version.match(/^V[\d.]+-\d+-(.+)$/);
    const branch = vMatch ? vMatch[1] : "develop";
    const type   = build_type || "debug";

    const elfUrl  = `${this.elfBaseUrl}/${branch}/${git_version}/${socKey}/${type}/${cfg.elfFile}`;
    const elfPath = path.join(
      this.elfCacheDir,
      `${git_version}-${socKey}-${type}.elf`,
    );

    console.log(`CrashDecoder [${ip}]: using firmware ${git_version} (${socKey}/${type})`);
    await this._ensureElf(elfUrl, elfPath);

    const decoded = await this._runDecode(cfg, elfPath, lines);

    if (this.onDecoded) {
      this.onDecoded({
        sourceIp:   ip,
        receivedAt: triggerRecord.receivedAt,
        tag:        triggerRecord.tag,
        app:        triggerRecord.app,
        gitVersion: git_version,
        soc:        socKey,
        buildType:  type,
        message:    decoded,
        raw:        lines.join("\n"),
        _crashDecode: true,
      });
    }
  }

  _fetchFirmwareInfo(ip) {
    return new Promise((resolve) => {
      const req = http.get(
        {
          hostname: ip,
          port: 80,
          path: "/info?v=2",
          headers: { Accept: "application/json" },
          timeout: 5000,
        },
        (res) => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            res.resume();
            return resolve(null);
          }
          let body = "";
          res.setEncoding("utf8");
          res.on("data", c => (body += c));
          res.on("end", () => {
            try {
              const j = JSON.parse(body);
              resolve({
                git_version: j?.app?.git_version ?? j?.git_version ?? null,
                soc:         j?.device?.soc       ?? j?.soc         ?? null,
                build_type:  j?.app?.build_type   ?? j?.build_type   ?? "debug",
              });
            } catch {
              resolve(null);
            }
          });
        },
      );
      req.on("timeout", () => { req.destroy(); resolve(null); });
      req.on("error",   ()          => resolve(null));
    });
  }

  async _ensureElf(url, localPath) {
    await fsp.mkdir(path.dirname(localPath), { recursive: true });

    try {
      await fsp.access(localPath);
      return;
    } catch { /* file not cached */ }

    const tmpPath = localPath + ".tmp";
    await new Promise((resolve, reject) => {
      const lib  = url.startsWith("https") ? https : http;
      const file = fs.createWriteStream(tmpPath);
      lib.get(url, (res) => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          res.resume();
          file.close(() => reject(new Error(`HTTP ${res.statusCode} downloading ELF: ${url}`)));
          return;
        }
        res.pipe(file);
        file.on("finish", () => file.close(resolve));
        file.on("error",  reject);
      }).on("error", e => { file.close(() => reject(e)); });
    });

    await fsp.rename(tmpPath, localPath);
  }

  _runDecode(cfg, elfPath, lines) {
    return new Promise((resolve, reject) => {
      const env = {
        ...process.env,
        SMING_SOC:  cfg.smingSOC,
        SMING_ARCH: cfg.smingArch,
      };

      const proc = spawn("python3", [cfg.script, elfPath], {
        env,
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      proc.stdout.on("data", d => (stdout += d));
      proc.stderr.on("data", d => (stderr += d));

      proc.on("error", reject);
      proc.on("close", (code) => {
        if (code !== 0 && !stdout) {
          reject(new Error(`decode-stacktrace exited ${code}: ${stderr.slice(0, 500)}`));
        } else {
          resolve(stdout || stderr);
        }
      });

      proc.stdin.write(lines.join("\n") + "\n\n");
      proc.stdin.end();
    });
  }
}

module.exports = { CrashDecoder };
