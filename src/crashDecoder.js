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
const crypto = require("crypto");
const http = require("http");
const https = require("https");
const { AIContextHarvester, firmwareArtifactUrls } = require("./aiContextHarvester");

function stripAnsi(str) {
  return String(str || "").replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").trim();
}

function normalizeCrashDumpLine(line) {
  return stripAnsi(line).replace(/^[\w.$<>~]+(?:::[\w.$<>~]+)+:\s*/, "");
}

function logExcerpt(text, maxLength = 800) {
  return stripAnsi(text).replace(/\s+/g, " ").slice(0, maxLength);
}

function decodeFailureWithDump(message, rawDump) {
  return `${message}\n\nRaw stack dump:\n${rawDump || "(empty dump)"}`;
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
const CRASH_REPORTER_RE = /(?:^|::)reportCrashDump:/;
// Grammar of lines that may appear inside a crash dump (after logger-prefix normalization).
// Anything else ends collection, so lost UDP lines cannot make the dump absorb normal logs.
const CRASH_DUMP_LINE_RES = [
  CRASH_TRIGGER_RE,
  STACK_HEADER_RE,
  STACK_LINE_RE,
  /^(?:Backtrace:\s*)?(?:0x[0-9a-f]{8}:0x[0-9a-f]{8}\s*)+(?:\|<-CORRUPTED)?\s*$/i,
  /^(?:[a-z]\w*=(?:0x)?[0-9a-f]+\s*)+$/i,                     // epc2=0x.. exccause=4 reason=3
  /^(?:[A-Z][A-Z0-9]*\s*:\s*0x[0-9a-f]{8}\s*)+$/,             // PC      : 0x400d5ca5  PS      : ...
  /^Core\s+\d+\s+register dump:\s*$/i,
  /^Backtrace\s*\(\d+ frames?\):\s*$/i,
  /^#\d+\s+pc=0x[0-9a-f]+\s*$/i,
  /^\*{3}.*\*{3}/,                                             // *** CORE DUMP FOUND *** ...
  /^Corrupted SP:/i,
  /^Stack dump skipped\b/i,
  /^Exception \(\d+\):\s*$/i,                                  // ESP8266 core
  /^ctx:\s*\w+\s*$/i,
  /^sp:\s*[0-9a-f]+\s+end:\s*[0-9a-f]+\s+offset:\s*[0-9a-f]+\s*$/i,
  /^(?:>>>stack>>>|<<<stack<<<)\s*$/,
  /^-+\s*CUT HERE\b.*-+\s*$/i,
  /^ELF file SHA256:/i,
  /^Rebooting\.\.\.\s*$/i,
];
const MAX_CRASH_DUMP_LINES = 1024;

function isCrashDumpLine(rawMsg, cleanMsg) {
  return CRASH_REPORTER_RE.test(stripAnsi(rawMsg)) || CRASH_DUMP_LINE_RES.some(re => re.test(cleanMsg));
}

const EM_XTENSA = 94;
const EM_RISCV = 243;
const ARTIFACT_KINDS = ["elf", "map"];
const MAP_SIGNATURES = ["Archive member included", "Memory Configuration", "Linker script and memory map", "Discarded input sections"];

class ArtifactError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

async function fileContains(filePath, needle) {
  const pattern = Buffer.from(needle, "utf8");
  if (!pattern.length) return false;
  let tail = Buffer.alloc(0);
  for await (const chunk of fs.createReadStream(filePath, { highWaterMark: 1 << 20 })) {
    const window = Buffer.concat([tail, chunk]);
    if (window.includes(pattern)) return true;
    tail = window.subarray(Math.max(0, window.length - pattern.length + 1));
  }
  return false;
}

async function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

async function readHead(filePath, length) {
  const handle = await fsp.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function readJsonFile(filePath) {
  try { return JSON.parse(await fsp.readFile(filePath, "utf8")); } catch { return null; }
}

const SOC_CONFIG = {
  esp8266: {
    script:          path.join(__dirname, "../tools/decode-esp8266.py"),
    remoteScriptUrl: "https://raw.githubusercontent.com/SmingHub/Sming/develop/Sming/Arch/Esp8266/Tools/decode-stacktrace.py",
    elfFile:         "app_0.out",
    elfMachine:      EM_XTENSA,
    smingArch:       "Esp8266",
    smingSOC:        "esp8266",
  },
  esp32: {
    script:          path.join(__dirname, "../tools/decode-esp32.py"),
    remoteScriptUrl: "https://raw.githubusercontent.com/SmingHub/Sming/develop/Sming/Arch/Esp32/Tools/decode-stacktrace.py",
    elfFile:         "app.out",
    elfMachine:      EM_XTENSA,
    smingArch:       "Esp32",
    smingSOC:        "esp32",
  },
  esp32c3: {
    script:          path.join(__dirname, "../tools/decode-esp32.py"),
    remoteScriptUrl: "https://raw.githubusercontent.com/SmingHub/Sming/develop/Sming/Arch/Esp32/Tools/decode-stacktrace.py",
    elfFile:         "app.out",
    elfMachine:      EM_RISCV,
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
    const cleanMsg = normalizeCrashDumpLine(rawMsg);
    const ip = record.sourceIp;

    if (!cleanMsg || !ip) return false;

    let state = this._collecting.get(ip);
    const isTrigger = CRASH_TRIGGER_RE.test(cleanMsg);

    // A trigger once the stack section has been seen belongs to a new report.
    if (state && isTrigger && state.inStack) {
      this._finalize(ip);
      state = null;
    }

    if (!state) {
      if (!isTrigger) return false;

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

    if (!isCrashDumpLine(rawMsg, cleanMsg)) {
      this._finalize(ip);
      return false;
    }

    clearTimeout(state.timer);
    state.lines.push(cleanMsg);
    if (STACK_HEADER_RE.test(cleanMsg)) state.inStack = true;

    if (state.lines.length >= MAX_CRASH_DUMP_LINES) {
      this._log(ip, state.triggerRecordId, `Dump reached ${MAX_CRASH_DUMP_LINES} lines; finishing collection`, "warn");
      this._finalize(ip);
    } else {
      state.timer = setTimeout(() => this._finalize(ip), 5000);
    }
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

  async _resolveTargetInfo(ip, boot, bootNonce) {
    const storedBootInfo = this.storage?.getBootFirmwareInfo?.(ip, boot, bootNonce) ||
      this.discovery?.getBootInfo?.(ip, boot, bootNonce);
    if (storedBootInfo?.git_version && storedBootInfo?.soc) return storedBootInfo;

    if (this.discovery) {
      const known = this.discovery.controllers.get(ip);
      const currentBoot = this.discovery.bootNumbers?.get(ip);
      if (known?.gitVersion && known?.soc && (boot == null || currentBoot == null || currentBoot === boot)) {
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
          "SELECT soc, build_type, git_version, sming_version, boot_nonce FROM controllers WHERE ip = ?"
        ).get(ip);
        const currentBoot = this.discovery?.bootNumbers?.get(ip);
        if (row?.git_version && row?.soc && (boot == null || currentBoot == null || currentBoot === boot)) {
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

    return null;
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
    const storedBootInfo = this.storage?.getBootFirmwareInfo?.(ip, triggerRecord.boot, triggerRecord.bootNonce) ||
      this.discovery?.getBootInfo?.(ip, triggerRecord.boot, triggerRecord.bootNonce);
    const info = storedBootInfo?.git_version && storedBootInfo?.soc
      ? storedBootInfo
      : (triggerRecord.gitVersion && triggerRecord.soc
      ? { git_version: triggerRecord.gitVersion, sming_version: triggerRecord.smingVersion, soc: triggerRecord.soc, build_type: triggerRecord.buildType }
      : await this._resolveTargetInfo(ip, triggerRecord.boot, triggerRecord.bootNonce));
    if (this.storage && triggerRecordId) {
      await this.storage.updateCrashDecode(triggerRecordId, "[Crash dump detected, decoding in progress...]", {
        gitVersion: info?.git_version, smingVersion: info?.sming_version, soc: info?.soc, buildType: info?.build_type || "debug", rawDump: lines.join("\n"),
      });
    }
    if (!info || !info.git_version || !info.soc) {
      const reason = `[Crash decode skipped: target metadata missing for ${ip}]`;
      const msg = decodeFailureWithDump(reason, lines.join("\n"));
      this._log(ip, triggerRecordId, `${reason}; info=${JSON.stringify(info || null)}`, "warn");
      if (this.storage && triggerRecordId) {
        await this.storage.updateCrashDecode(triggerRecordId, msg);
      }
      return;
    }

    const { git_version, sming_version, soc, build_type } = info;
    const socKey = soc.toLowerCase();
    const cfg    = SOC_CONFIG[socKey];

    if (!cfg) {
      const reason = `[Crash decode skipped: unsupported SOC "${soc}"]`;
      const msg = decodeFailureWithDump(reason, lines.join("\n"));
      this._log(ip, triggerRecordId, reason, "warn");
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

    const elfUrls = firmwareArtifactUrls(this.elfBaseUrl, branch, git_version, socKey, type, cfg.elfFile);
    let elfPath;
    try {
      elfPath = this._elfCachePath(git_version, socKey, type);
    } catch (err) {
      const reason = `[Crash decode skipped: ${err.message}]`;
      this._log(ip, triggerRecordId, reason, "warn");
      if (this.storage && triggerRecordId) {
        await this.storage.updateCrashDecode(triggerRecordId, decodeFailureWithDump(reason, lines.join("\n")));
      }
      return;
    }

    try {
      this._log(ip, triggerRecordId, `Preparing ELF ${path.basename(elfPath)}`);
      await this._ensureElf(elfUrls, elfPath);
    } catch (err) {
      const reason = `[Crash decode error: failed downloading ELF: ${err.message}]`;
      const msg = decodeFailureWithDump(reason, lines.join("\n"));
      this._log(ip, triggerRecordId, `${reason}; urls=${elfUrls.join(" or ")}`, "error");
      if (this.storage && triggerRecordId) {
        await this.storage.updateCrashDecode(triggerRecordId, msg);
      }
      return;
    }

    this._log(ip, triggerRecordId, `Preparing decoder script ${cfg.script}`);
    const scriptReady = await this._ensureScript(cfg);
    if (scriptReady === false) {
      const reason = `[Crash decode error: decoder script unavailable at ${cfg.script}]`;
      const msg = decodeFailureWithDump(reason, lines.join("\n"));
      this._log(ip, triggerRecordId, reason, "error");
      if (this.storage && triggerRecordId) await this.storage.updateCrashDecode(triggerRecordId, msg);
      return;
    }

    await this._ensureMapFile(git_version, socKey, type, elfPath);

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
      decoded = decodeFailureWithDump(`[Crash decode error: ${err.message}]`, lines.join("\n"));
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

  async _ensureElf(urls, localPath, maxRedirects = 3) {
    await fsp.mkdir(path.dirname(localPath), { recursive: true });
    try {
      await fsp.access(localPath);
      console.info(`CrashDecoder: ELF cache hit at ${localPath}`);
      return;
    } catch {}

    if (!Array.isArray(urls)) urls = [urls];
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

    let lastError;
    for (const url of urls) {
      console.info(`CrashDecoder: downloading ELF from ${url}`);
      try {
        await download(url, maxRedirects);
        await fsp.rename(tmpPath, localPath);
        const { size } = await fsp.stat(localPath);
        console.info(`CrashDecoder: ELF ready at ${localPath} (${size} bytes)`);
        return;
      } catch (error) {
        lastError = error;
        await fsp.unlink(tmpPath).catch(() => {});
      }
    }
    throw lastError || new Error("No firmware artifact URLs available");
  }

  async _ensureMapFile(gitVersion, soc, buildType, elfPath) {
    const mapPath = path.join(path.dirname(elfPath), `${path.basename(elfPath, path.extname(elfPath))}.map`);
    try {
      await fsp.access(mapPath);
      console.info(`CrashDecoder: map cache hit at ${mapPath}`);
      return true;
    } catch {}

    if (!this.harvester?.fetchMapFile) return false;
    try {
      const mapContent = await this.harvester.fetchMapFile(gitVersion, soc, buildType);
      if (!mapContent) {
        console.debug(`CrashDecoder: matching map file unavailable for ${gitVersion}/${soc}/${buildType}`);
        return false;
      }

      await fsp.mkdir(path.dirname(mapPath), { recursive: true });
      const temporaryPath = `${mapPath}.tmp`;
      await fsp.writeFile(temporaryPath, mapContent, "utf8");
      await fsp.rename(temporaryPath, mapPath);
      console.info(`CrashDecoder: staged matching map at ${mapPath} (${Buffer.byteLength(mapContent)} bytes)`);
      return true;
    } catch (error) {
      console.warn(`CrashDecoder: could not stage matching map ${mapPath}: ${error.message}`);
      return false;
    }
  }

  _elfCachePath(gitVersion, socKey, buildType) {
    const root = path.resolve(this.elfCacheDir);
    const elfPath = path.resolve(root, `${gitVersion}-${socKey}-${buildType}.elf`);
    if (!elfPath.startsWith(root + path.sep)) {
      throw new Error(`firmware version "${gitVersion}" does not map to a safe ELF cache path`);
    }
    return elfPath;
  }

  _artifactUploadDir() {
    return path.join(path.resolve(this.elfCacheDir), ".uploads");
  }

  /** Firmware identity and cache locations used to decode a stored crash report. */
  _artifactTarget(triggerRecordId) {
    const { rawLog, ip, git_version, soc, build_type } = this._resolveRecordFirmware(triggerRecordId);
    if (!rawLog) throw new ArtifactError(`Crash report ${triggerRecordId} not found`, 404);
    if (!git_version || !soc) throw new ArtifactError("Crash report has no recorded firmware version or SoC", 409);
    const socKey = soc.toLowerCase();
    const cfg = SOC_CONFIG[socKey];
    if (!cfg) throw new ArtifactError(`Unsupported SOC "${soc}"`, 422);
    const buildType = build_type || "debug";
    let elfPath;
    try {
      elfPath = this._elfCachePath(git_version, socKey, buildType);
    } catch (err) {
      throw new ArtifactError(err.message, 422);
    }
    const mapPath = path.join(path.dirname(elfPath), `${path.basename(elfPath, ".elf")}.map`);
    const harvesterMapPath = this.harvester?.mapCachePath?.(git_version, socKey, buildType) || null;
    return { ip, gitVersion: git_version, soc: socKey, buildType, cfg, elfPath, mapPath, harvesterMapPath };
  }

  async _artifactInfo(filePath) {
    let stat;
    try { stat = await fsp.stat(filePath); } catch { return { present: false }; }
    const upload = await readJsonFile(`${filePath}.upload.json`);
    return {
      present: true,
      size: stat.size,
      source: upload ? "uploaded" : "downloaded",
      ...(upload ? { uploadedAt: upload.uploadedAt, originalName: upload.originalName, sha256: upload.sha256 } : {}),
    };
  }

  async artifactStatus(triggerRecordId) {
    const target = this._artifactTarget(triggerRecordId);
    return {
      id: triggerRecordId,
      ip: target.ip || null,
      gitVersion: target.gitVersion,
      soc: target.soc,
      buildType: target.buildType,
      elf: await this._artifactInfo(target.elfPath),
      map: await this._artifactInfo(target.mapPath),
    };
  }

  /**
   * Validate an uploaded ELF or linker map and install it in the per-firmware-version
   * cache used by automatic and manual decoding. Consumes `uploadedPath`.
   */
  async storeUploadedArtifact(triggerRecordId, kind, uploadedPath, originalName = null) {
    try {
      if (!ARTIFACT_KINDS.includes(kind)) throw new ArtifactError(`Unknown artifact kind "${kind}"; expected elf or map`);
      const target = this._artifactTarget(triggerRecordId);
      const { size } = await fsp.stat(uploadedPath);
      if (!size) throw new ArtifactError(`Uploaded ${kind} file is empty`);
      const head = await readHead(uploadedPath, 64 * 1024);

      if (kind === "elf") {
        if (head.length < 20 || head.readUInt32BE(0) !== 0x7f454c46) {
          throw new ArtifactError("Uploaded file is not an ELF image");
        }
        if (head[4] !== 1) throw new ArtifactError("Uploaded ELF is not a 32-bit image");
        const machine = head[5] === 2 ? head.readUInt16BE(18) : head.readUInt16LE(18);
        if (machine !== target.cfg.elfMachine) {
          throw new ArtifactError(`Uploaded ELF machine ${machine} does not match ${target.soc} (expected ${target.cfg.elfMachine})`, 422);
        }
        if (!await fileContains(uploadedPath, target.gitVersion)) {
          throw new ArtifactError(`Uploaded ELF does not contain firmware version "${target.gitVersion}"; it is not the build that crashed`, 422);
        }
      } else {
        const text = head.toString("latin1");
        if (head.includes(0) || !MAP_SIGNATURES.some(signature => text.includes(signature))) {
          throw new ArtifactError("Uploaded file does not look like a GNU ld linker map");
        }
      }

      const sha256 = await sha256File(uploadedPath);
      const destination = kind === "elf" ? target.elfPath : target.mapPath;
      const marker = { uploadedAt: new Date().toISOString(), originalName: originalName ? path.basename(String(originalName)) : null, size, sha256 };
      await fsp.mkdir(path.dirname(destination), { recursive: true });
      await fsp.writeFile(`${destination}.upload.json`, JSON.stringify(marker));
      await fsp.rename(uploadedPath, destination);

      if (kind === "elf") {
        // A new ELF invalidates any map cached for this version; it may belong to an older build.
        for (const stale of [target.mapPath, `${target.mapPath}.upload.json`, target.harvesterMapPath]) {
          if (stale) await fsp.unlink(stale).catch(() => {});
        }
      } else if (target.harvesterMapPath) {
        await fsp.mkdir(path.dirname(target.harvesterMapPath), { recursive: true });
        const temporaryPath = `${target.harvesterMapPath}.tmp`;
        await fsp.copyFile(destination, temporaryPath);
        await fsp.rename(temporaryPath, target.harvesterMapPath);
      }
      this._log(target.ip || "manual", triggerRecordId,
        `Installed uploaded ${kind} for ${target.gitVersion}/${target.soc}/${target.buildType} (${size} bytes, sha256 ${sha256.slice(0, 12)})`);
      return { id: triggerRecordId, kind, gitVersion: target.gitVersion, soc: target.soc, buildType: target.buildType, ...marker };
    } finally {
      await fsp.unlink(uploadedPath).catch(() => {});
    }
  }

  analyzeRecord(triggerRecordId, onProgress = null) {
    return this._enqueueDecode(() => this._analyzeRecord(triggerRecordId, true, onProgress));
  }

  rerunRecord(triggerRecordId) {
    return this._enqueueDecode(async () => {
      try {
        return await this._analyzeRecord(triggerRecordId, false);
      } catch (error) {
        const record = this.storage?.getCrashRecord?.(triggerRecordId);
        const rawDump = record?.raw || record?.message;
        if (!rawDump) throw error;
        const decoded = decodeFailureWithDump(`[Crash decode error: ${error.message}]`, rawDump);
        await this.storage.updateCrashDecode(triggerRecordId, decoded);
        this._log(record.sourceIp || record.ip || "manual", triggerRecordId, `Decoder rerun failed: ${error.message}`, "error");
        return decoded;
      }
    });
  }

  _recoverStoredStackRows(triggerRecordId, ip, boot, rawLog) {
    if (!this.db || !rawLog || !STACK_HEADER_RE.test(rawLog)) return rawLog;
    const existingStackRows = rawLog.split("\n").filter(line =>
      STACK_LINE_RE.test(normalizeCrashDumpLine(line)) || BACKTRACE_LINE_RE.test(normalizeCrashDumpLine(line))
    ).length;
    const rows = this.db.prepare(`SELECT message FROM logs
      WHERE ip = ? AND boot IS ? AND id >= ? ORDER BY id ASC LIMIT 64`).all(ip, boot ?? null, triggerRecordId);
    const recovered = [];
    let inStack = false;
    let recoveredStackRows = 0;

    for (const row of rows) {
      const line = normalizeCrashDumpLine(row.message);
      if (!inStack) {
        if (recovered.length && !isCrashDumpLine(row.message, line)) break;
        recovered.push(line);
        if (STACK_HEADER_RE.test(line)) inStack = true;
        continue;
      }
      if (STACK_LINE_RE.test(line) || BACKTRACE_LINE_RE.test(line)) {
        recovered.push(line);
        recoveredStackRows++;
      } else {
        break;
      }
    }

    if (recoveredStackRows <= existingStackRows) return rawLog;
    this._log(ip, triggerRecordId,
      `Recovered ${recoveredStackRows} stack rows from adjacent logs; stored dump had ${existingStackRows}`);
    return recovered.join("\n");
  }

  /** Saved raw dump and the firmware build of the boot that produced a stored crash report. */
  _resolveRecordFirmware(triggerRecordId) {
    let rawLog = null;
    let ip = null;
    let git_version = null;
    let sming_version = null;
    let soc = null;
    let build_type = null;
    let boot = null;
    let boot_nonce = null;

    if (this.storage && typeof this.storage.getCrashRecord === "function") {
      const rec = this.storage.getCrashRecord(triggerRecordId);
      if (rec) {
        rawLog = rec.raw || rec.message;
        ip = rec.sourceIp || rec.ip;
        boot = rec.boot;
        boot_nonce = rec.bootNonce;
        git_version = rec.gitVersion;
        sming_version = rec.smingVersion;
        soc = rec.soc;
        build_type = rec.buildType;
      }
    }

    if (!rawLog && this.db) {
      try {
        const row = this.db.prepare("SELECT message, source_ip, git_version, sming_version, soc, build_type, crash_raw, boot, boot_nonce FROM logs WHERE id = ? AND crash_decode IS NOT NULL").get(triggerRecordId);
        if (row) {
          rawLog = row.crash_raw || row.message;
          ip = row.source_ip;
          boot = row.boot;
          boot_nonce = row.boot_nonce;
          git_version = row.git_version;
          sming_version = row.sming_version;
          soc = row.soc;
          build_type = row.build_type || "debug";
        }
      } catch (e) {
        console.debug(`CrashDecoder: DB query for record ${triggerRecordId} failed: ${e.message}`);
      }
    }

    const bootInfo = this.storage?.getBootFirmwareInfo?.(ip, boot, boot_nonce) ||
      (this.db && boot != null
        ? this.db.prepare(`SELECT soc, build_type, git_version, sming_version FROM controller_boot_info
          WHERE ip = ? AND boot = ?`).get(ip, boot)
        : null);
    if (bootInfo) {
      git_version = bootInfo.git_version || git_version;
      sming_version = bootInfo.sming_version || sming_version;
      soc = bootInfo.soc || soc;
      build_type = bootInfo.build_type || build_type;
    }
    return { rawLog, ip, boot, git_version, sming_version, soc, build_type };
  }

  async _analyzeRecord(triggerRecordId, analyzeWithAI = true, onProgress = null) {
    this._log("manual", triggerRecordId, `${analyzeWithAI ? "Starting AI re-analysis" : "Starting decoder rerun"}`);
    let { rawLog, ip, boot, git_version, sming_version, soc, build_type } = this._resolveRecordFirmware(triggerRecordId);

    if (!rawLog) {
      this._log(ip || "manual", triggerRecordId, "Cannot rerun: saved crash dump was not found", "error");
      throw new Error("Crash log or raw dump not found for analysis.");
    }

    rawLog = this._recoverStoredStackRows(triggerRecordId, ip, boot, rawLog);

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

    const elfUrls = firmwareArtifactUrls(this.elfBaseUrl, branch, git_version, socKey, type, cfg.elfFile);
    const elfPath = this._elfCachePath(git_version, socKey, type);

    await this._ensureElf(elfUrls, elfPath);
    await this._ensureScript(cfg);
    await this._ensureMapFile(git_version, socKey, type, elfPath);

    onProgress?.({ type: "stage", stage: "repositories" });
    const repoPaths = await this._getSourceRepos(git_version, sming_version);
    const lines = rawLog.split("\n");
    let decoded;
    let codeSnippets = [];
    onProgress?.({ type: "stage", stage: "decoding" });
    try {
      ({ decoded, codeSnippets } = await this._decodeWithContext(cfg, elfPath, lines, repoPaths));
    } catch (err) {
      decoded = decodeFailureWithDump(`[Crash decode error: ${err.message}]`, rawLog);
    }

    let finalDecoded = decoded;
    if (analyzeWithAI) {
      if (!this.aiService || !this.aiService.isAvailable()) {
        throw new Error("AI service is not configured.");
      }
      const aiAnalysisResult = await this._analyzeDecoded(decoded, codeSnippets, repoPaths, git_version, socKey, type, onProgress);
      finalDecoded = `${decoded}\n\n--- AI Analysis ---\n\n${aiAnalysisResult}`;
    }

    if (this.storage && typeof this.storage.updateCrashDecode === "function") {
      await this.storage.updateCrashDecode(triggerRecordId, finalDecoded, {
        gitVersion: git_version,
        smingVersion: sming_version,
        soc: socKey,
        buildType: type,
        rawDump: rawLog,
      });
    }

    return finalDecoded;
  }

  async _analyzeDecoded(decoded, codeSnippets, repoPaths, gitVersion, soc, buildType, onProgress = null) {
    onProgress?.({ type: "stage", stage: "map" });
    const mapSymbols = await this.harvester.fetchMapFile(gitVersion, soc, buildType);
    const disassembly = stripAnsi(decoded).match(/Disassembly around[^\n]*\n(?:[ \t]*[0-9a-f]+:[^\n]*(?:\n|$))+/gi)?.join("\n") || "";
    return this.aiService.analyzeCrash({
      soc, gitVersion, decodedText: decoded.split("\n\nSource context:\n")[0], codeSnippets, mapSymbols, disassembly,
      harvester: this.harvester, repoPaths,
      ...(onProgress ? { onProgress } : {}),
    });
  }

  async _getSourceRepos(gitVersion, smingVersion = "develop") {
    const repoPaths = {};
    const repos = [
      ["Sming", "https://github.com/pljakobs/Sming.git", "develop"],
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
    lines = lines.map(normalizeCrashDumpLine);
    let decoded = await this._runDecode(cfg, elfPath, lines, repoPaths);
    const upload = await readJsonFile(`${elfPath}.upload.json`);
    if (upload) {
      decoded = `[Decoded with user-uploaded ELF${upload.originalName ? ` "${upload.originalName}"` : ""}, sha256 ${String(upload.sha256).slice(0, 12)}, uploaded ${upload.uploadedAt}]\n${decoded}`;
    }
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
      const decoderInput = lines.join("\n") + "\n\n";
      const stackRows = decoderInput.split("\n").filter(line => STACK_LINE_RE.test(line)).length;
      console.info(`CrashDecoder: spawning python3 script=${cfg.script} elf=${path.resolve(elfPath)} cwd=${cwd || process.cwd()} input=${lines.length} lines/${stackRows} stack rows/${Buffer.byteLength(decoderInput)} bytes`);
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
        if (stdout.trim()) {
          const plainOutput = stripAnsi(stdout);
          console.info(`CrashDecoder: decoder output markers register=${plainOutput.includes("Register decode")} stack=${plainOutput.includes("Stack Dump")} calculatedFrames=${plainOutput.includes("Calculated Stack Trace")}`);
          console.info(`CrashDecoder: decoder stdout preview: ${logExcerpt(stdout, 700)}`);
        }
        if (stderr.trim()) {
          const message = `CrashDecoder: decoder stderr: ${logExcerpt(stderr)}`;
          (code === 0 ? console.debug : console.error)(message);
        }
        if (code !== 0 && stdout) {
          console.error(`CrashDecoder: decoder returned partial stdout despite exit code ${code}: ${logExcerpt(stdout)}`);
        }
        if (code !== 0) {
          reject(new Error(`decode-stacktrace exited ${code}: ${logExcerpt(stderr) || "no stderr output"}`));
        } else {
          resolve(stdout || stderr);
        }
      });

      proc.stdin.write(decoderInput);
      proc.stdin.end();
    });
  }
}

module.exports = { CrashDecoder, ArtifactError, stripAnsi, extractCrashFingerprint };