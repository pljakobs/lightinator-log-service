/**
 * crashDecoder.js
 *
 * Detects crash dump lines arriving via syslog, resolves matching target ELF
 * using version metadata registered from alive controllers (or database / live HTTP fallback),
 * runs the Sming stacktrace decoder, and stores the decoded output on the crash log entry.
 */

"use strict";

const { spawn } = require("child_process");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const http = require("http");
const https = require("https");

function stripAnsi(str) {
  return String(str || "").replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").trim();
}

/**
 * Parses decoded crash text to extract exception cause, PC frame, top-of-stack frame,
 * and builds a deterministic fingerprint string.
 * @param {string} decodedText
 * @returns {{ exccause: string, pcFrame: string, tosFrame: string, fingerprint: string }}
 */
function extractCrashFingerprint(decodedText) {
  if (!decodedText || typeof decodedText !== "string") {
    return { exccause: "", pcFrame: "", tosFrame: "", fingerprint: "" };
  }

  let exccause = "";
  let pcFrame = "";
  let tosFrame = "";

  // 1. Extract exccause (e.g. "Fatal exception (28):" or "excvaddr=...")
  const excMatch = decodedText.match(/(?:Fatal exception\s*\(([^)]+)\)|Guru Meditation Error:\s*([^\r\n]+))/i);
  if (excMatch) {
    exccause = (excMatch[1] || excMatch[2] || "").trim();
  }

  // 2. Extract PC / Top-of-stack frames from decoded stack traces
  const lines = decodedText.split("\n");
  for (const line of lines) {
    const trimmed = stripAnsi(line);
    if (!pcFrame && /(?:pc=|->\s*0x[0-9a-f]+)/i.test(trimmed)) {
      pcFrame = trimmed;
    } else if (!tosFrame && /0x[0-9a-f]{8}\s+in\s+/i.test(trimmed)) {
      tosFrame = trimmed;
    }
  }

  const rawFingerprint = `${exccause}|${pcFrame}|${tosFrame}`;
  const fingerprint = rawFingerprint !== "||" ? rawFingerprint : "";

  return { exccause, pcFrame, tosFrame, fingerprint };
}

// Regex matching the initial trigger line of a crash
const CRASH_TRIGGER_RE = /(?:Fatal exception|Guru Meditation Error|pc=0x[0-9a-f]+\s+sp=0x[0-9a-f]+\s+excvaddr=0x[0-9a-f]+|epc1=0x[0-9a-f]+)/i;

// Regex matching stack header lines
const STACK_HEADER_RE = /(?:[Ss]tack dump:|[Ss]tack memory:|Backtrace:)/i;

// Regex matching individual stack trace lines
const STACK_LINE_RE = /^[0-9a-f]{8}:\s+(?:0x)?[0-9a-f]{8}/i;
const BACKTRACE_LINE_RE = /(?:Backtrace:\s*)?(?:0x[0-9a-f]{8}:0x[0-9a-f]{8}\s*)+/i;

const SOC_CONFIG = {
  esp8266: {
    script:          path.join(__dirname, "../tools/decode-esp8266.py"),
    remoteScriptUrl: "https://raw.githubusercontent.com/SmingHub/Sming/develop/Sming/Arch/Esp8266/Tools/decode-stacktrace.py",
    elfFile:         "app_0.out",
    smingArch:       "Esp8266",
    smingSOC:        "esp8266",
  },
  esp32: {
    script:          path.join(__dirname, "../tools/decode-esp32.py"),
    remoteScriptUrl: "https://raw.githubusercontent.com/SmingHub/Sming/develop/Sming/Arch/Esp32/Tools/decode-stacktrace.py",
    elfFile:         "app.out",
    smingArch:       "Esp32",
    smingSOC:        "esp32",
  },
  esp32c3: {
    script:          path.join(__dirname, "../tools/decode-esp32.py"),
    remoteScriptUrl: "https://raw.githubusercontent.com/SmingHub/Sming/develop/Sming/Arch/Esp32/Tools/decode-stacktrace.py",
    elfFile:         "app.out",
    smingArch:       "Esp32",
    smingSOC:        "esp32c3",
  },
};

class CrashDecoder {
  /**
   * @param {object} opts
   * @param {string}              opts.elfCacheDir Directory where ELF files are cached
   * @param {string}              opts.elfBaseUrl  Base URL for ELF downloads
   * @param {ControllerDiscovery} [opts.discovery] ControllerDiscovery instance tracking active nodes
   * @param {import('better-sqlite3').Database} [opts.db] SQLite database instance
   * @param {LogStorage}          [opts.storage]   LogStorage instance for updating records
   * @param {Function}            [opts.onDecoded] Called with decoded log record
   */
  constructor({ elfCacheDir, elfBaseUrl, discovery = null, db = null, storage = null, onDecoded = null }) {
    this.elfCacheDir = elfCacheDir;
    this.elfBaseUrl  = elfBaseUrl;
    this.discovery   = discovery;
    this.db          = db;
    this.storage     = storage;
    this.onDecoded   = onDecoded;

    // ip → { triggerRecordId, triggerRecord, lines: string[], inStack: boolean, timer: Timeout }
    this._collecting = new Map();
  }

  feed(record) {
    const rawMsg = record.message || "";
    const cleanMsg = stripAnsi(rawMsg);
    const ip = record.sourceIp;

    if (!cleanMsg || !ip) return false;

    // Check if this line marks the beginning of a crash dump
    if (CRASH_TRIGGER_RE.test(cleanMsg)) {
      const existing = this._collecting.get(ip);
      // Start a new crash session if not already in one or if previous wasn't actively in stack
      if (!existing || !existing.inStack) {
        if (existing?.timer) clearTimeout(existing.timer);

        const isStackHeader = STACK_HEADER_RE.test(cleanMsg);
        const triggerRecordId = record.id;

        this._collecting.set(ip, {
          triggerRecordId,
          triggerRecord: record,
          lines: [cleanMsg],
          inStack: isStackHeader,
          timer: setTimeout(() => this._finalize(ip), 5000),
        });

        // Mark on the database record that crash decode is pending
        if (this.storage && triggerRecordId) {
          this.storage.updateCrashDecode(triggerRecordId, "[Crash dump detected, decoding in progress...]").catch(() => {});
        }

        return true;
      }
    }

    const state = this._collecting.get(ip);
    if (!state) return false;

    // Reset inactivity timer
    clearTimeout(state.timer);
    state.timer = setTimeout(() => this._finalize(ip), 5000);

    // Check for stack dump header (e.g. "Stack dump:")
    if (STACK_HEADER_RE.test(cleanMsg)) {
      state.lines.push(cleanMsg);
      state.inStack = true;
      return true;
    }

    if (state.inStack) {
      if (STACK_LINE_RE.test(cleanMsg) || BACKTRACE_LINE_RE.test(cleanMsg)) {
        state.lines.push(cleanMsg);
        return true;
      }

      // Non-stack line encountered (blank line, next syslog message, reboot marker) -> finalize
      this._finalize(ip);
      return false;
    }

    // Still in pre-stack registers section (e.g. ps=..., sar=..., r00:...)
    state.lines.push(cleanMsg);
    return true;
  }

  _finalize(ip) {
    const state = this._collecting.get(ip);
    if (!state) return;
    clearTimeout(state.timer);
    this._collecting.delete(ip);

    const { triggerRecordId, triggerRecord, lines } = state;
    setImmediate(() => {
      this._decode(ip, triggerRecordId, triggerRecord, lines).catch(e => {
        console.warn(`CrashDecoder [${ip}]: decode failed — ${e.message}`);
      });
    });
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

    // 2. Try resolving target version from SQLite database
    if (this.db) {
      try {
        const row = this.db.prepare(
          "SELECT soc, build_type, git_version FROM controllers WHERE ip = ?"
        ).get(ip);
        if (row?.git_version && row?.soc) {
          return {
            git_version: row.git_version,
            soc:         row.soc,
            build_type:  row.build_type || "debug",
          };
        }
      } catch (e) {
        console.debug(`CrashDecoder [${ip}]: DB query failed: ${e.message}`);
      }
    }

    // 3. Fall back to live /info?v=2 endpoint directly (retry once in case controller is rebooting)
    let info = await this._fetchFirmwareInfo(ip);
    if (!info?.git_version) {
      await new Promise(resolve => setTimeout(resolve, 3000));
      info = await this._fetchFirmwareInfo(ip);
    }
    return info;
  }

  async _decode(ip, triggerRecordId, triggerRecord, lines) {
    const info = await this._resolveTargetInfo(ip);
    if (!info || !info.git_version || !info.soc) {
      const msg = `[Crash decode skipped: target metadata missing for ${ip}]`;
      console.warn(`CrashDecoder [${ip}]: target metadata missing (git_version/soc) — skipping decode`);
      if (this.storage && triggerRecordId) {
        await this.storage.updateCrashDecode(triggerRecordId, msg);
        await this.storage.append(ip, {
          receivedAt: new Date().toISOString(),
          facility: 1,
          severity: 4,
          tag: "crash-decoder",
          message: msg,
          sourceIp: ip,
        });
      }
      return;
    }

    const { git_version, soc, build_type } = info;
    const socKey = soc.toLowerCase();
    const cfg    = SOC_CONFIG[socKey];

    if (!cfg) {
      const msg = `[Crash decode skipped: unsupported SOC "${soc}"]`;
      console.warn(`CrashDecoder [${ip}]: unsupported SOC "${soc}" — skipping decode`);
      if (this.storage && triggerRecordId) {
        await this.storage.updateCrashDecode(triggerRecordId, msg);
        await this.storage.append(ip, {
          receivedAt: new Date().toISOString(),
          facility: 1,
          severity: 4,
          tag: "crash-decoder",
          message: msg,
          sourceIp: ip,
        });
      }
      return;
    }

    const vMatch = git_version.match(/^V[\d.]+-\d+-(.+)$/i);
    const branch = vMatch ? vMatch[1] : "develop";
    const type   = build_type || "debug";

    const elfUrl  = `${this.elfBaseUrl}/${branch}/${git_version}/${socKey}/${type}/${cfg.elfFile}`;
    const elfPath = path.join(
      this.elfCacheDir,
      `${git_version}-${socKey}-${type}.elf`,
    );

    console.log(`CrashDecoder [${ip}]: using firmware ${git_version} (${socKey}/${type})`);
    try {
      await this._ensureElf(elfUrl, elfPath);
    } catch (err) {
      const msg = `[Crash decode error: failed downloading ELF from ${elfUrl}: ${err.message}]`;
      console.warn(`CrashDecoder [${ip}]: ${msg}`);
      if (this.storage && triggerRecordId) {
        await this.storage.updateCrashDecode(triggerRecordId, msg);
        await this.storage.append(ip, {
          receivedAt: new Date().toISOString(),
          facility: 1,
          severity: 3,
          tag: "crash-decoder",
          message: msg,
          sourceIp: ip,
        });
      }
      return;
    }

    await this._ensureScript(cfg);

    let decoded;
    try {
      decoded = await this._runDecode(cfg, elfPath, lines);
      if (this.storage) {
        await this.storage.append(ip, {
          receivedAt: new Date().toISOString(),
          facility: 1,
          severity: 6,
          tag: "crash-decoder",
          message: `[Crash decode completed successfully for ${git_version}]`,
          sourceIp: ip,
        });
      }
    } catch (err) {
      console.warn(`CrashDecoder [${ip}]: decode failed — ${err.message}`);
      decoded = `[Crash decode error: ${err.message}]\n\nRaw dump:\n` + lines.join("\n");
      if (this.storage) {
        await this.storage.append(ip, {
          receivedAt: new Date().toISOString(),
          facility: 1,
          severity: 3,
          tag: "crash-decoder",
          message: `[Crash decode execution failed: ${err.message}]`,
          sourceIp: ip,
        });
      }
    }

    if (this.storage && triggerRecordId) {
      await this.storage.updateCrashDecode(triggerRecordId, decoded).catch(e => {
        console.warn(`CrashDecoder [${ip}]: failed updating database row: ${e.message}`);
      });
    }

    if (this.onDecoded) {
      const fingerprintData = extractCrashFingerprint(decoded);

      this.onDecoded({
        id:          triggerRecordId,
        sourceIp:    ip,
        receivedAt:  triggerRecord.receivedAt,
        tag:         triggerRecord.tag,
        app:         triggerRecord.app,
        gitVersion:  git_version,
        soc:         socKey,
        buildType:   type,
        message:     decoded,
        raw:         lines.join("\n"),
        crashDecode: decoded,
        fingerprint: fingerprintData.fingerprint,
        exccause:    fingerprintData.exccause,
        pcFrame:     fingerprintData.pcFrame,
        tosFrame:    fingerprintData.tosFrame,
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
          timeout: 4000,
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

  async _ensureScript(cfg) {
    if (fs.existsSync(cfg.script)) return;
    if (!cfg.remoteScriptUrl) return;

    try {
      console.log(`CrashDecoder: downloading script ${cfg.script} from ${cfg.remoteScriptUrl}`);
      await fsp.mkdir(path.dirname(cfg.script), { recursive: true });
      const tmpPath = cfg.script + ".tmp";
      await new Promise((resolve, reject) => {
        const file = fs.createWriteStream(tmpPath);
        https.get(cfg.remoteScriptUrl, (res) => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            file.close(() => {
              fs.unlink(tmpPath, () => {});
              reject(new Error(`HTTP ${res.statusCode} downloading script ${cfg.remoteScriptUrl}`));
            });
            return;
          }
          res.pipe(file);
          file.on("finish", () => file.close(resolve));
          file.on("error", (err) => {
            file.close(() => {
              fs.unlink(tmpPath, () => {});
              reject(err);
            });
          });
        }).on("error", (e) => {
          file.close(() => {
            fs.unlink(tmpPath, () => {});
            reject(e);
          });
        });
      });
      await fsp.chmod(tmpPath, 0o755);
      await fsp.rename(tmpPath, cfg.script);
      console.log(`CrashDecoder: downloaded script ${cfg.script}`);
    } catch (err) {
      console.warn(`CrashDecoder: could not download script ${cfg.script}: ${err.message}`);
    }
  }

  async _ensureElf(url, localPath, maxRedirects = 3) {
    await fsp.mkdir(path.dirname(localPath), { recursive: true });

    try {
      await fsp.access(localPath);
      return;
    } catch { /* file not cached */ }

    const tmpPath = localPath + ".tmp";
    const download = (targetUrl, redirectsLeft) => {
      return new Promise((resolve, reject) => {
        const lib = targetUrl.startsWith("https") ? https : http;
        const file = fs.createWriteStream(tmpPath);
        lib.get(targetUrl, (res) => {
          if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location && redirectsLeft > 0) {
            res.resume();
            file.close(() => {
              fs.unlink(tmpPath, () => {});
              const nextUrl = new URL(res.headers.location, targetUrl).toString();
              download(nextUrl, redirectsLeft - 1).then(resolve, reject);
            });
            return;
          }
          if (res.statusCode < 200 || res.statusCode >= 300) {
            res.resume();
            file.close(() => {
              fs.unlink(tmpPath, () => {});
              reject(new Error(`HTTP ${res.statusCode} downloading ELF: ${targetUrl}`));
            });
            return;
          }
          res.pipe(file);
          file.on("finish", () => file.close(resolve));
          file.on("error", (err) => {
            file.close(() => {
              fs.unlink(tmpPath, () => {});
              reject(err);
            });
          });
        }).on("error", (e) => {
          file.close(() => {
            fs.unlink(tmpPath, () => {});
            reject(e);
          });
        });
      });
    };

    await download(url, maxRedirects);
    await fsp.rename(tmpPath, localPath);
  }

  _runDecode(cfg, elfPath, lines) {
    return new Promise((resolve, reject) => {
      const env = {
        ...process.env,
        PATH: process.env.PATH ? `/usr/local/bin:${process.env.PATH}` : "/usr/local/bin:/usr/bin:/bin",
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

module.exports = { CrashDecoder, stripAnsi, extractCrashFingerprint };