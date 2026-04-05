/**
 * crashDecoder.js
 *
 * Detects crash dump lines arriving via syslog (from esp_rgbww_firmware's
 * reportCrashDump()), downloads the matching ELF from lightinator.de, runs
 * the Sming decode-stacktrace.py script, and emits a decoded log record.
 *
 * Expected syslog line sequence (decode-stacktrace.py compatible):
 *
 *   pc=0x40201234 sp=0x3ffff350 excvaddr=0x00000000   ← triggers collection
 *   epc2=0x... epc3=0x... exccause=3 depc=0x...        ← pass-through
 *   Stack dump:
 *   3ffff350:  40201234 3ffef888 00000001 3ffef8c0
 *   ...
 *   <blank line>                                       ← ends collection
 *
 * ELF URL pattern (built by CI):
 *   http://lightinator.de/download/{branch}/{version}/{soc}/{type}/app_0.out
 *   http://lightinator.de/download/{branch}/{version}/{soc}/{type}/app.out
 *
 * Firmware /info?v=2 response:
 *   { device: { soc: "Esp8266" }, app: { git_version: "V5.0-123-develop", build_type: "debug" } }
 */

"use strict";

const { spawn } = require("child_process");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const http = require("http");
const https = require("https");

// Regex that identifies the first line of a crash dump
const CRASH_TRIGGER_RE = /pc=0x[0-9a-f]+ +sp=0x[0-9a-f]+ +excvaddr=0x[0-9a-f]+/i;

// Per-SOC configuration: which decode script, addr2line binary, ELF filename,
// and SMING_SOC value to set when invoking the ESP32 script.
const SOC_CONFIG = {
  esp8266: {
    script:   path.join(__dirname, "../tools/decode-esp8266.py"),
    elfFile:  "app_0.out",
    smingArch: "Esp8266",
    smingSOC:  "esp8266",
  },
  esp32: {
    script:   path.join(__dirname, "../tools/decode-esp32.py"),
    elfFile:  "app.out",
    smingArch: "Esp32",
    smingSOC:  "esp32",
  },
  esp32c3: {
    script:   path.join(__dirname, "../tools/decode-esp32.py"),
    elfFile:  "app.out",
    smingArch: "Esp32",
    smingSOC:  "esp32c3",
  },
};

class CrashDecoder {
  /**
   * @param {object} opts
   * @param {string}   opts.elfCacheDir  Directory where ELF files are cached
   * @param {string}   opts.elfBaseUrl   Base URL for ELF downloads
   *                                     e.g. "http://lightinator.de/download"
   * @param {Function} opts.onDecoded    Called with a synthetic log record
   *                                     containing the decoded stack output.
   */
  constructor({ elfCacheDir, elfBaseUrl, onDecoded }) {
    this.elfCacheDir = elfCacheDir;
    this.elfBaseUrl  = elfBaseUrl;
    this.onDecoded   = onDecoded;

    // ip → { lines: string[], inStack: boolean }
    this._collecting = new Map();
  }

  /**
   * Feed a parsed syslog record.
   * Returns true if the line is part of a crash dump (caller may still store
   * it normally; this is non-exclusive).
   */
  feed(record) {
    const msg = (record.message || "").trimEnd();
    const ip  = record.sourceIp;

    // Start of crash dump
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

    // Blank line after stack data = end of dump
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

  // ── Private ────────────────────────────────────────────────────────────────

  async _decode(ip, triggerRecord, lines) {
    const info = await this._fetchFirmwareInfo(ip);
    if (!info || !info.git_version || !info.soc) {
      console.warn(`CrashDecoder [${ip}]: could not fetch /info?v=2 — skipping decode`);
      return;
    }

    const { git_version, soc, build_type } = info;
    const socKey = soc.toLowerCase();
    const cfg    = SOC_CONFIG[socKey];

    if (!cfg) {
      console.warn(`CrashDecoder [${ip}]: unsupported SOC "${soc}" — skipping decode`);
      return;
    }

    // Parse git_version: "V5.0-{build}-{branch}"
    const vMatch = git_version.match(/^V[\d.]+-\d+-(.+)$/);
    const branch = vMatch ? vMatch[1] : "develop";
    const type   = build_type || "debug";

    const elfUrl  = `${this.elfBaseUrl}/${branch}/${git_version}/${socKey}/${type}/${cfg.elfFile}`;
    const elfPath = path.join(
      this.elfCacheDir,
      `${git_version}-${socKey}-${type}.elf`,
    );

    console.log(`CrashDecoder [${ip}]: fetching ELF from ${elfUrl}`);
    await this._ensureElf(elfUrl, elfPath);

    console.log(`CrashDecoder [${ip}]: running decode-stacktrace.py`);
    const decoded = await this._runDecode(cfg, elfPath, lines);

    if (this.onDecoded) {
      this.onDecoded({
        sourceIp:   ip,
        receivedAt: triggerRecord.receivedAt,
        tag:        triggerRecord.tag,
        app:        triggerRecord.app,
        message:    decoded,
        raw:        lines.join("\n"),
        // Tell loki.js to use a distinct label
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
                git_version: j?.app?.git_version ?? null,
                soc:         j?.device?.soc       ?? null,
                build_type:  j?.app?.build_type   ?? "debug",
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

    // Return immediately if already cached
    try {
      await fsp.access(localPath);
      return;
    } catch { /* not cached */}

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

      // Feed crash lines then a blank line to signal end-of-input to the script
      proc.stdin.write(lines.join("\n") + "\n\n");
      proc.stdin.end();
    });
  }
}

module.exports = { CrashDecoder };
