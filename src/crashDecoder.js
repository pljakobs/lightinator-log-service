/**
 * crashDecoder.js
 *
 * Detects crash dump lines arriving via syslog, resolves matching target ELF/map,
 * runs the Sming stacktrace decoder, executes multi-pass context-aware AI analysis,
 * and stores the decoded output and analysis on the crash log entry.
 */

"use strict";

const { spawn } = require("child_process");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const http = require("http");
const https = require("https");
const { AIContextHarvester } = require("./aiContextHarvester");

function stripAnsi(str) {
  return String(str || "").replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").trim();
}

function extractCrashFingerprint(decodedText) {
  if (!decodedText || typeof decodedText !== "string") {
    return { exccause: "", pcFrame: "", tosFrame: "", fingerprint: "" };
  }

  let exccause = "";
  let pcFrame = "";
  let tosFrame = "";

  const excMatch = decodedText.match(/(?:Fatal exception\s*\(([^)]+)\)|Guru Meditation Error:\s*([^\r\n]+))/i);
  if (excMatch) {
    exccause = (excMatch[1] || excMatch[2] || "").trim();
  }

  const lines = decodedText.split("\n");
  for (const line of lines) {
    const trimmed = stripAnsi(line);
    if (!pcFrame && /(?:pc=|->\s*0x[0-9a-f]+)/i.test(trimmed)) {
      pcFrame = trimmed;
    } else if (!tosFrame && /0x[0-9a-f]{8}\s+in\s+/i.test(trimmed)) {
      tosFrame = trimmed;
    }
  }

  const rawFingerprint = `${exccause}|${pcFrame}\vert{}${tosFrame}`;
  const fingerprint = rawFingerprint !== "||" ? rawFingerprint : "";

  return { exccause, pcFrame, tosFrame, fingerprint };
}

const CRASH_TRIGGER_RE = /(?:Fatal exception|Guru Meditation Error|pc=0x[0-9a-f]+\s+sp=0x[0-9a-f]+\s+excvaddr=0x[0-9a-f]+|epc1=0x[0-9a-f]+)/i;
const STACK_HEADER_RE = /(?:[Ss]tack dump:|[Ss]tack memory:|Backtrace:)/i;
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
  constructor({ elfCacheDir, elfBaseUrl, discovery = null, db = null, storage = null, aiService = null, onDecoded = null }) {
    this.elfCacheDir = elfCacheDir;
    this.elfBaseUrl  = elfBaseUrl;
    this.discovery   = discovery;
    this.db          = db;
    this.storage     = storage;
    this.aiService   = aiService;
    this.onDecoded   = onDecoded;

    this.harvester = new AIContextHarvester({ elfBaseUrl });
    this.harvester.init().catch(() => {});

    this._collecting = new Map();
  }

  feed(record) {
    const rawMsg = record.message || "";
    const cleanMsg = stripAnsi(rawMsg);
    const ip = record.sourceIp;

    if (!cleanMsg || !ip) return false;

    if (CRASH_TRIGGER_RE.test(cleanMsg)) {
      const existing = this._collecting.get(ip);
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

        if (this.storage && triggerRecordId) {
          this.storage.updateCrashDecode(triggerRecordId, "[Crash dump detected, decoding in progress...]").catch(() => {});
        }

        return true;
      }
    }

    const state = this._collecting.get(ip);
    if (!state) return false;

    clearTimeout(state.timer);
    state.timer = setTimeout(() => this._finalize(ip), 5000);

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

      this._finalize(ip);
      return false;
    }

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
        console.warn(`CrashDecoder [${ip}]: decode failed —${e.message}`);
      });
    });
  }

  async _resolveTargetInfo(ip) {
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
        console.debug(`CrashDecoder [${ip}]: DB query failed:${e.message}`);
      }
    }

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
      if (this.storage && triggerRecordId) {
        await this.storage.updateCrashDecode(triggerRecordId, msg);
      }
      return;
    }

    const { git_version, soc, build_type } = info;
    const socKey = soc.toLowerCase();
    const cfg    = SOC_CONFIG[socKey];

    if (!cfg) {
      const msg = `[Crash decode skipped: unsupported SOC "${soc}"]`;
      if (this.storage && triggerRecordId) {
        await this.storage.updateCrashDecode(triggerRecordId, msg);
      }
      return;
    }

    const vMatch = git_version.match(/^V[\d.]+-\d+-(.+)$/i);
    const branch = vMatch ? vMatch[1] : "develop";
    const type   = build_type || "debug";

    const elfUrl  = `${this.elfBaseUrl}/${branch}/${git_version}/${socKey}/${type}/${cfg.elfFile}`;
    const elfPath = path.join(this.elfCacheDir, `${git_version}-${socKey}-${type}.elf`);

    try {
      await this._ensureElf(elfUrl, elfPath);
    } catch (err) {
      const msg = `[Crash decode error: failed downloading ELF: ${err.message}]`;
      if (this.storage && triggerRecordId) {
        await this.storage.updateCrashDecode(triggerRecordId, msg);
      }
      return;
    }

    await this._ensureScript(cfg);

    let decoded;
    try {
      decoded = await this._runDecode(cfg, elfPath, lines);
    } catch (err) {
      decoded = `[Crash decode error: ${err.message}]\n\nRaw dump:\n` + lines.join("\n");
    }

    // Execute Multi-Pass AI Analysis if available
    let aiAnalysisResult = null;
    if (this.aiService && this.aiService.isAvailable()) {
      try {
        console.log(`CrashDecoder [${ip}]: Initiating multi-pass AI analysis...`);
        
        // Sync Repositories
        const smingPath = await this.harvester.ensureRepo("Sming", "https://github.com/pljakobs/Sming.git", "develop");
        const fwRepoPath = await this.harvester.ensureRepo("esp-rgbww-firmware", "https://github.com/pljakobs/esp-rgbww-firmware.git", branch);
        
        const mapSymbols = await this.harvester.fetchMapFile(git_version, socKey, type);
        const codeSnippets = await this.harvester.extractSnippets(decoded, { Sming: smingPath, "esp-rgbww-firmware": fwRepoPath });

        // Pass 1 Analysis
        const pass1 = await this.aiService.runPass1({
          soc: socKey,
          gitVersion: git_version,
          decodedText: decoded,
          codeSnippets,
          mapSymbols,
        });

        // Pass 2 Remediation Generation
        const pass2 = await this.aiService.runPass2({
          pass1Result: pass1,
          supplementalSnippets: codeSnippets,
        });

        aiAnalysisResult = `### AI Pass 1: Anatomical & Gap Analysis\n${pass1}\n\n### AI Pass 2: Root-Cause Remediation\n${pass2}`;
        decoded = `${decoded}\n\n---\n\n${aiAnalysisResult}`;
      } catch (aiErr) {
        console.warn(`CrashDecoder [${ip}]: AI analysis pipeline failed:${aiErr.message}`);
      }
    }

    if (this.storage && triggerRecordId) {
      await this.storage.updateCrashDecode(triggerRecordId, decoded, {
        gitVersion: git_version,
        soc: socKey,
        buildType: type
      }).catch(() => {});
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
        aiAnalysis:  aiAnalysisResult,
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
      await fsp.mkdir(path.dirname(cfg.script), { recursive: true });
      const tmpPath = cfg.script + ".tmp";
      await new Promise((resolve, reject) => {
        const file = fs.createWriteStream(tmpPath);
        https.get(cfg.remoteScriptUrl, (res) => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            file.close(() => {
              fs.unlink(tmpPath, () => {});
              reject(new Error(`HTTP ${res.statusCode} downloading script`));
            });
            return;
          }
          res.pipe(file);
          file.on("finish", () => file.close(resolve));
          file.on("error", (err) => {
            file.close(() => { fs.unlink(tmpPath, () => {}); reject(err); });
          });
        }).on("error", (e) => {
          file.close(() => { fs.unlink(tmpPath, () => {}); reject(e); });
        });
      });
      await fsp.chmod(tmpPath, 0o755);
      await fsp.rename(tmpPath, cfg.script);
    } catch (err) {
      console.warn(`CrashDecoder: could not download script: ${err.message}`);
    }
  }

  async _ensureElf(url, localPath, maxRedirects = 3) {
    await fsp.mkdir(path.dirname(localPath), { recursive: true });
    try {
      await fsp.access(localPath);
      return;
    } catch {}

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
              download(new URL(res.headers.location, targetUrl).toString(), redirectsLeft - 1).then(resolve, reject);
            });
            return;
          }
          if (res.statusCode < 200 || res.statusCode >= 300) {
            res.resume();
            file.close(() => { fs.unlink(tmpPath, () => {}); reject(new Error(`HTTP ${res.statusCode}`)); });
            return;
          }
          res.pipe(file);
          file.on("finish", () => file.close(resolve));
          file.on("error", (err) => { file.close(() => { fs.unlink(tmpPath, () => {}); reject(err); }); });
        }).on("error", (e) => { file.close(() => { fs.unlink(tmpPath, () => {}); reject(e); }); });
      });
    };

    await download(url, maxRedirects);
    await fsp.rename(tmpPath, localPath);
  }

  async analyzeRecord(triggerRecordId) {
    let rawLog = null;
    let ip = null;
    let git_version = null;
    let soc = null;
    let build_type = "debug";

    if (this.storage && typeof this.storage.getCrashRecord === "function") {
      const rec = this.storage.getCrashRecord(triggerRecordId);
      if (rec) {
        rawLog = rec.raw || rec.message;
        ip = rec.sourceIp || rec.ip;
        git_version = rec.gitVersion;
        soc = rec.soc;
        build_type = rec.buildType || "debug";
      }
    }

    if (!rawLog && this.db) {
      try {
        const row = this.db.prepare("SELECT message, source_ip, git_version, soc, build_type, crash_decode FROM logs WHERE id = ?").get(triggerRecordId);
        if (row) {
          rawLog = row.crash_decode || row.message;
          ip = row.source_ip;
          git_version = row.git_version;
          soc = row.soc;
          build_type = row.build_type || "debug";
        }
      } catch (e) {
        console.debug(`CrashDecoder: DB query for record ${triggerRecordId} failed: ${e.message}`);
      }
    }

    if (!rawLog) {
      throw new Error("Crash log or raw dump not found for analysis.");
    }

    if ((!git_version || !soc) && ip) {
      const info = await this._resolveTargetInfo(ip);
      if (info) {
        git_version = git_version || info.git_version;
        soc = soc || info.soc;
        build_type = build_type || info.build_type;
      }
    }

    if (!git_version || !soc) {
      throw new Error("Target metadata (git_version or soc) missing for analysis.");
    }

    const socKey = soc.toLowerCase();
    const cfg = SOC_CONFIG[socKey];
    if (!cfg) {
      throw new Error(`Unsupported SOC "${soc}"`);
    }

    const vMatch = git_version.match(/^V[\d.]+-\d+-(.+)$/i);
    const branch = vMatch ? vMatch[1] : "develop";
    const type = build_type || "debug";

    const elfUrl = `${this.elfBaseUrl}/${branch}/${git_version}/${socKey}/${type}/${cfg.elfFile}`;
    const elfPath = path.join(this.elfCacheDir, `${git_version}-${socKey}-${type}.elf`);

    await this._ensureElf(elfUrl, elfPath);
    await this._ensureScript(cfg);

    const lines = rawLog.split("\n");
    let decoded;
    try {
      decoded = await this._runDecode(cfg, elfPath, lines);
    } catch (err) {
      decoded = rawLog;
    }

    if (!this.aiService || !this.aiService.isAvailable()) {
      throw new Error("AI service is not configured.");
    }

    const smingPath = await this.harvester.ensureRepo("Sming", "https://github.com/pljakobs/Sming.git", "develop");

    const fwRepoPath = await this.harvester.ensureRepo("esp-rgbww-firmware", "https://github.com/pljakobs/esp_rgbww_firmware.git", git_version);

    const mapSymbols = await this.harvester.fetchMapFile(git_version, socKey, type);
    const codeSnippets = await this.harvester.extractSnippets(decoded, { Sming: smingPath, "esp-rgbww-firmware": fwRepoPath });

    const pass1 = await this.aiService.runPass1({
      soc: socKey,
      gitVersion: git_version,
      decodedText: decoded,
      codeSnippets,
      mapSymbols,
    });

    const pass2 = await this.aiService.runPass2({
      pass1Result: pass1,
      supplementalSnippets: codeSnippets,
    });

    const aiAnalysisResult = `### AI Pass 1: Anatomical & Gap Analysis\n${pass1}\n\n### AI Pass 2: Root-Cause Remediation\n${pass2}`;
    const finalDecoded = `${decoded}\n\n---\n\n${aiAnalysisResult}`;

    if (this.storage && typeof this.storage.updateCrashDecode === "function") {
      await this.storage.updateCrashDecode(triggerRecordId, finalDecoded, {
        gitVersion: git_version,
        soc: socKey,
        buildType: type
      });
    }

    return finalDecoded;
  }

  _runDecode(cfg, elfPath, lines) {
    return new Promise((resolve, reject) => {
      const env = {
        ...process.env,
        PATH: process.env.PATH ? `/usr/local/bin:${process.env.PATH}` : "/usr/local/bin:/usr/bin:/bin",
        SMING_SOC:  cfg.smingsSOC || cfg.smingSOC,
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
          reject(new Error(`decode-stacktrace exited ${code}:${stderr.slice(0, 500)}`));
        } else {
          resolve(stdout || stderr);
        }
      });

      proc.stdin.write(lines.join("\n") + "\n\n");
      proc.stdin.end();
    });
  }
}

module.exports = { CrashDecoder, stripAnsi, extractCrashFingerprint };