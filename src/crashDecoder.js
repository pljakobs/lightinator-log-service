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

function logExcerpt(text, maxLength = 800) {
  return stripAnsi(text).replace(/\s+/g, " ").slice(0, maxLength);
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
  constructor({ elfCacheDir, elfBaseUrl, discovery = null, db = null, storage = null, aiService = null, aiEnabled = true, onDecoded = null }) {
    this.elfCacheDir = elfCacheDir;
    this.elfBaseUrl  = elfBaseUrl;
    this.discovery   = discovery;
    this.db          = db;
    this.storage     = storage;
    this.aiService   = aiService;
    this.aiEnabled   = aiEnabled;
    this.onDecoded   = onDecoded;

    this.harvester = new AIContextHarvester({ elfBaseUrl });
    this.harvester.init().catch(() => {});

    this._collecting = new Map();
    this._decodeQueue = Promise.resolve();
  }

  feed(record) {
    const rawMsg = record.message || "";
    const cleanMsg = stripAnsi(rawMsg).replace(/^Application::reportCrashDump:\s*/, "");
    const ip = record.sourceIp;

    if (!cleanMsg || !ip) return false;

    if (CRASH_TRIGGER_RE.test(cleanMsg)) {
      const existing = this._collecting.get(ip);
      if (!existing || !existing.inStack) {
        if (existing?.timer) clearTimeout(existing.timer);

        const isStackHeader = STACK_HEADER_RE.test(cleanMsg);
        const triggerRecordId = record.id;
        const known = this.discovery?.controllers.get(ip);
        this._log(ip, triggerRecordId, `Crash detected; collecting dump${isStackHeader ? " (stack header present)" : ""}`);

        this._collecting.set(ip, {
          triggerRecordId,
          triggerRecord: {
            ...record,
            gitVersion: record.gitVersion || known?.gitVersion,
            smingVersion: record.smingVersion || known?.smingVersion,
            soc: record.soc || known?.soc,
            buildType: record.buildType || known?.buildType,
          },
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
    this._log(ip, triggerRecordId,
      `Dump collection complete: ${lines.length} lines, ${Buffer.byteLength(lines.join("\n"))} bytes; queueing decode`);
    setImmediate(() => {
      this._decode(ip, triggerRecordId, triggerRecord, lines).catch(e => {
        this._log(ip, triggerRecordId, `Decode pipeline failed: ${e.stack || e.message}`, "error");
      });
    });
  }

  _log(ip, recordId, message, level = "info") {
    const logger = console[level] || console.log;
    logger.call(console, `CrashDecoder [${ip}]${recordId != null ? ` record=${recordId}` : ""}: ${message}`);
  }

  async _resolveTargetInfo(ip) {
    if (this.discovery) {
      const known = this.discovery.controllers.get(ip);
      if (known?.gitVersion && known?.soc) {
        return {
          git_version: known.gitVersion,
          sming_version: known.smingVersion,
          soc:         known.soc,
          build_type:  known.buildType || "debug",
        };
      }
    }

    if (this.db) {
      try {
        const row = this.db.prepare(
          "SELECT soc, build_type, git_version, sming_version FROM controllers WHERE ip = ?"
        ).get(ip);
        if (row?.git_version && row?.soc) {
          return {
            git_version: row.git_version,
            sming_version: row.sming_version,
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

  _enqueueDecode(task) {
    if (this.aiService) return this.aiService.enqueue(task);
    const result = this._decodeQueue.then(task);
    this._decodeQueue = result.catch(() => {});
    return result;
  }

  _decode(ip, triggerRecordId, triggerRecord, lines) {
    return this._enqueueDecode(() => this._decodeRecord(ip, triggerRecordId, triggerRecord, lines));
  }

  async _decodeRecord(ip, triggerRecordId, triggerRecord, lines) {
    this._log(ip, triggerRecordId, `Starting decode for ${lines.length} captured lines`);
    const metadataSource = triggerRecord.gitVersion && triggerRecord.soc ? "log record" : "controller lookup";
    this._log(ip, triggerRecordId, `Resolving firmware metadata from ${metadataSource}`);
    const info = triggerRecord.gitVersion && triggerRecord.soc
      ? { git_version: triggerRecord.gitVersion, sming_version: triggerRecord.smingVersion, soc: triggerRecord.soc, build_type: triggerRecord.buildType }
      : await this._resolveTargetInfo(ip);
    if (this.storage && triggerRecordId) {
      await this.storage.updateCrashDecode(triggerRecordId, "[Crash dump detected, decoding in progress...]", {
        gitVersion: info?.git_version, smingVersion: info?.sming_version, soc: info?.soc, buildType: info?.build_type || "debug", rawDump: lines.join("\n"),
      });
    }
    if (!info || !info.git_version || !info.soc) {
      const msg = `[Crash decode skipped: target metadata missing for ${ip}]`;
      this._log(ip, triggerRecordId, `${msg}; info=${JSON.stringify(info || null)}`, "warn");
      if (this.storage && triggerRecordId) {
        await this.storage.updateCrashDecode(triggerRecordId, msg);
      }
      return;
    }

    const { git_version, sming_version, soc, build_type } = info;
    const socKey = soc.toLowerCase();
    const cfg    = SOC_CONFIG[socKey];

    if (!cfg) {
      const msg = `[Crash decode skipped: unsupported SOC "${soc}"]`;
      this._log(ip, triggerRecordId, msg, "warn");
      if (this.storage && triggerRecordId) {
        await this.storage.updateCrashDecode(triggerRecordId, msg);
      }
      return;
    }

    const vMatch = git_version.match(/^V[\d.]+-\d+-(.+)$/i);
    const branch = vMatch ? vMatch[1] : "develop";
    const type   = build_type || "debug";
    this._log(ip, triggerRecordId,
      `Target firmware=${git_version}, Sming=${sming_version || "unknown"}, soc=${socKey}, build=${type}`);

    const elfUrl  = `${this.elfBaseUrl}/${branch}/${git_version}/${socKey}/${type}/${cfg.elfFile}`;
    const elfPath = path.join(this.elfCacheDir, `${git_version}-${socKey}-${type}.elf`);

    try {
      this._log(ip, triggerRecordId, `Preparing ELF ${path.basename(elfPath)}`);
      await this._ensureElf(elfUrl, elfPath);
    } catch (err) {
      const msg = `[Crash decode error: failed downloading ELF: ${err.message}]`;
      this._log(ip, triggerRecordId, `${msg}; url=${elfUrl}`, "error");
      if (this.storage && triggerRecordId) {
        await this.storage.updateCrashDecode(triggerRecordId, msg);
      }
      return;
    }

    this._log(ip, triggerRecordId, `Preparing decoder script ${cfg.script}`);
    const scriptReady = await this._ensureScript(cfg);
    if (scriptReady === false) {
      const msg = `[Crash decode error: decoder script unavailable at ${cfg.script}]`;
      this._log(ip, triggerRecordId, msg, "error");
      if (this.storage && triggerRecordId) await this.storage.updateCrashDecode(triggerRecordId, msg);
      return;
    }

    this._log(ip, triggerRecordId, "Loading source repositories for recorded builds");
    const repoPaths = await this._getSourceRepos(git_version, sming_version);
    let decoded;
    let codeSnippets = [];
    try {
      this._log(ip, triggerRecordId, "Running stacktrace decoder");
      ({ decoded, codeSnippets } = await this._decodeWithContext(cfg, elfPath, lines, repoPaths));
      this._log(ip, triggerRecordId,
        `Stacktrace decoder succeeded: ${Buffer.byteLength(decoded)} output bytes, ${codeSnippets.length} source snippets`);
    } catch (err) {
      this._log(ip, triggerRecordId, `Stacktrace decoder failed: ${err.stack || err.message}`, "error");
      decoded = `[Crash decode error: ${err.message}]\n\nRaw dump:\n` + lines.join("\n");
    }

    // Execute Multi-Pass AI Analysis if available
    let aiAnalysisResult = null;
    if (this.aiEnabled !== false && this.aiService && this.aiService.isAvailable()) {
      try {
        console.log(`CrashDecoder [${ip}]: Initiating context-aware AI analysis...`);
        aiAnalysisResult = await this._analyzeDecoded(decoded, codeSnippets, repoPaths, git_version, socKey, type);
        decoded = `${decoded}\n\n--- AI Analysis ---\n\n${aiAnalysisResult}`;
      } catch (aiErr) {
        this._log(ip, triggerRecordId, `AI analysis failed: ${aiErr.stack || aiErr.message}`, "error");
      }
    } else {
      this._log(ip, triggerRecordId, "AI analysis skipped (disabled or unavailable)", "debug");
    }
    
    if (this.storage && triggerRecordId) {
      await this.storage.updateCrashDecode(triggerRecordId, decoded, {
        gitVersion: git_version,
        smingVersion: sming_version,
        soc: socKey,
        buildType: type
      }).catch(() => {});
      this._log(ip, triggerRecordId, `Stored decoded output (${Buffer.byteLength(decoded)} bytes)`);
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
        smingVersion: sming_version,
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
                sming_version: j?.app?.sming_git_version ?? j?.app?.sming_version ??
                  j?.sming?.git_version ?? j?.sming?.version ?? j?.sming_git_version ?? j?.sming_version ?? null,
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
    if (fs.existsSync(cfg.script)) {
      console.info(`CrashDecoder: decoder script cached at ${cfg.script}`);
      return true;
    }
    if (!cfg.remoteScriptUrl) {
      console.warn(`CrashDecoder: decoder script missing and no download URL configured: ${cfg.script}`);
      return false;
    }

    try {
      console.info(`CrashDecoder: downloading decoder script from ${cfg.remoteScriptUrl}`);
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
      console.info(`CrashDecoder: decoder script ready at ${cfg.script}`);
      return true;
    } catch (err) {
      console.warn(`CrashDecoder: could not download script ${cfg.remoteScriptUrl}: ${err.stack || err.message}`);
      return false;
    }
  }

  async _ensureElf(url, localPath, maxRedirects = 3) {
    await fsp.mkdir(path.dirname(localPath), { recursive: true });
    try {
      await fsp.access(localPath);
      console.info(`CrashDecoder: ELF cache hit at ${localPath}`);
      return;
    } catch {}

    console.info(`CrashDecoder: downloading ELF from ${url}`);
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
    const { size } = await fsp.stat(localPath);
    console.info(`CrashDecoder: ELF ready at ${localPath} (${size} bytes)`);
  }

  analyzeRecord(triggerRecordId) {
    return this._enqueueDecode(() => this._analyzeRecord(triggerRecordId, true));
  }

  rerunRecord(triggerRecordId) {
    return this._enqueueDecode(() => this._analyzeRecord(triggerRecordId, false));
  }

  async _analyzeRecord(triggerRecordId, analyzeWithAI = true) {
    this._log("manual", triggerRecordId, `${analyzeWithAI ? "Starting AI re-analysis" : "Starting decoder rerun"}`);
    let rawLog = null;
    let ip = null;
    let git_version = null;
    let sming_version = null;
    let soc = null;
    let build_type = null;

    if (this.storage && typeof this.storage.getCrashRecord === "function") {
      const rec = this.storage.getCrashRecord(triggerRecordId);
      if (rec) {
        rawLog = rec.raw || rec.message;
        ip = rec.sourceIp || rec.ip;
        git_version = rec.gitVersion;
        sming_version = rec.smingVersion;
        soc = rec.soc;
        build_type = rec.buildType;
      }
    }

    if (!rawLog && this.db) {
      try {
        const row = this.db.prepare("SELECT message, source_ip, git_version, sming_version, soc, build_type, crash_raw FROM logs WHERE id = ? AND crash_decode IS NOT NULL").get(triggerRecordId);
        if (row) {
          rawLog = row.crash_raw || row.message;
          ip = row.source_ip;
          git_version = row.git_version;
          sming_version = row.sming_version;
          soc = row.soc;
          build_type = row.build_type || "debug";
        }
      } catch (e) {
        console.debug(`CrashDecoder: DB query for record ${triggerRecordId} failed: ${e.message}`);
      }
    }

    if (!rawLog) {
      this._log(ip || "manual", triggerRecordId, "Cannot rerun: saved crash dump was not found", "error");
      throw new Error("Crash log or raw dump not found for analysis.");
    }

    if (!git_version || !soc) {
      this._log(ip || "manual", triggerRecordId, "Cannot rerun: saved firmware version or SoC metadata is missing", "error");
      throw new Error("Original crash firmware metadata (git_version or soc) missing for analysis.");
    }

    this._log(ip || "unknown", triggerRecordId,
      `Using saved metadata firmware=${git_version}, Sming=${sming_version || "unknown"}, soc=${soc}, build=${build_type || "debug"}`);

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

    const repoPaths = await this._getSourceRepos(git_version, sming_version);
    const lines = rawLog.split("\n");
    let decoded;
    let codeSnippets = [];
    try {
      ({ decoded, codeSnippets } = await this._decodeWithContext(cfg, elfPath, lines, repoPaths));
    } catch (err) {
      decoded = rawLog;
    }

    let finalDecoded = decoded;
    if (analyzeWithAI) {
      if (!this.aiService || !this.aiService.isAvailable()) {
        throw new Error("AI service is not configured.");
      }
      const aiAnalysisResult = await this._analyzeDecoded(decoded, codeSnippets, repoPaths, git_version, socKey, type);
      finalDecoded = `${decoded}\n\n--- AI Analysis ---\n\n${aiAnalysisResult}`;
    }

    if (this.storage && typeof this.storage.updateCrashDecode === "function") {
      await this.storage.updateCrashDecode(triggerRecordId, finalDecoded, {
        gitVersion: git_version,
        smingVersion: sming_version,
        soc: socKey,
        buildType: type
      });
    }

    return finalDecoded;
  }

  async _analyzeDecoded(decoded, codeSnippets, repoPaths, gitVersion, soc, buildType) {
    const mapSymbols = await this.harvester.fetchMapFile(gitVersion, soc, buildType);
    const disassembly = stripAnsi(decoded).match(/Disassembly around[^\n]*\n(?:[ \t]*[0-9a-f]+:[^\n]*(?:\n|$))+/gi)?.join("\n") || "";
    return this.aiService.analyzeCrash({
      soc, gitVersion, decodedText: decoded.split("\n\nSource context:\n")[0], codeSnippets, mapSymbols, disassembly,
      harvester: this.harvester, repoPaths,
    });
  }

  async _getSourceRepos(gitVersion, smingVersion = "develop") {
    const repoPaths = {};
    const repos = [
      ["Sming", "https://github.com/pljakobs/Sming.git", smingVersion || "develop"],
      ["esp-rgbww-firmware", "https://github.com/pljakobs/esp_rgbww_firmware.git", gitVersion.toLowerCase()],
    ];
    await Promise.all(repos.map(async ([name, url, ref]) => {
      try {
        repoPaths[name] = await this.harvester.ensureRepo(name, url, ref);
      } catch (err) {
        console.warn(`CrashDecoder: source context unavailable for ${name} (${ref}): ${err.message}`);
      }
    }));
    return repoPaths;
  }

  async _decodeWithContext(cfg, elfPath, lines, repoPaths) {
    let decoded = await this._runDecode(cfg, elfPath, lines, repoPaths);
    let codeSnippets = [];
    try {
      codeSnippets = await this.harvester.extractSnippets(decoded, repoPaths);
      if (codeSnippets.length) {
        const sourceContext = codeSnippets.map(({ repo, file, targetLine, snippet }) =>
          `${repo}/${file}:${targetLine}\n${snippet}`
        ).join("\n\n");
        decoded += `\n\nSource context:\n${sourceContext}`;
      }
    } catch (err) {
      console.warn(`CrashDecoder: could not extract source context: ${err.message}`);
    }
    return { decoded, codeSnippets };
  }

  _runDecode(cfg, elfPath, lines, repoPaths = {}) {
    return new Promise((resolve, reject) => {
      const env = {
        ...process.env,
        PATH: process.env.PATH ? `/usr/local/bin:${process.env.PATH}` : "/usr/local/bin:/usr/bin:/bin",
        SMING_SOC:  cfg.smingsSOC || cfg.smingSOC,
        SMING_ARCH: cfg.smingArch,
      };

      const cwd = repoPaths["esp-rgbww-firmware"] || repoPaths.Sming;
      console.info(`CrashDecoder: spawning python3 script=${cfg.script} elf=${path.resolve(elfPath)} cwd=${cwd || process.cwd()}`);
      const proc = spawn("python3", [cfg.script, path.resolve(elfPath)], {
        env,
        cwd,
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      proc.stdout.on("data", d => (stdout += d));
      proc.stderr.on("data", d => (stderr += d));

      proc.on("error", err => {
        console.error(`CrashDecoder: could not start python3 decoder: ${err.stack || err.message}`);
        reject(err);
      });
      proc.on("close", (code) => {
        console.info(`CrashDecoder: decoder process exited code=${code}, stdout=${Buffer.byteLength(stdout)} bytes, stderr=${Buffer.byteLength(stderr)} bytes`);
        if (stderr.trim()) {
          const message = `CrashDecoder: decoder stderr: ${logExcerpt(stderr)}`;
          (code === 0 ? console.debug : console.error)(message);
        }
        if (code !== 0 && stdout) {
          console.error(`CrashDecoder: decoder returned partial stdout despite exit code ${code}: ${logExcerpt(stdout)}`);
        }
        if (code !== 0 && !stdout) {
          reject(new Error(`decode-stacktrace exited ${code}: ${logExcerpt(stderr) || "no stderr output"}`));
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