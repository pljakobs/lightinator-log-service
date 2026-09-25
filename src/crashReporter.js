/**
 * crashDecoder.js
 *
 * Detects crash dump lines arriving via syslog, resolves matching target ELF,
 * checks out corresponding Sming and firmware repository branches, extracts
 * relevant code snippets, queries the Gemini API for technical root cause analysis,
 * and stores the enhanced output on the crash log entry.
 */

"use strict";

const { spawn, execSync } = require("child_process");
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
 */
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
  /**
   * @param {object} opts
   * @param {string} opts.elfCacheDir
   * @param {string} opts.elfBaseUrl
   * @param {string} [opts.workspaceDir]
   * @param {string} [opts.geminiApiKey]
   */
  constructor({ elfCacheDir, elfBaseUrl, workspaceDir, geminiApiKey, discovery = null, db = null, storage = null, onDecoded = null }) {
    this.elfCacheDir  = elfCacheDir;
    this.elfBaseUrl   = elfBaseUrl;
    this.workspaceDir = workspaceDir || path.join(process.cwd(), "data", "workspace");
    this.geminiApiKey = geminiApiKey || "";
    this.discovery    = discovery;
    this.db           = db;
    this.storage      = storage;
    this.onDecoded    = onDecoded;

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
        return { git_version: known.gitVersion, soc: known.soc, build_type: known.buildType || "debug" };
      }
    }
    if (this.db) {
      try {
        const row = this.db.prepare("SELECT soc, build_type, git_version FROM controllers WHERE ip = ?").get(ip);
        if (row?.git_version && row?.soc) {
          return { git_version: row.git_version, soc: row.soc, build_type: row.build_type || "debug" };
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

  /**
   * Ensures repositories are cloned and checked out to the specified branch.
   */
  async _ensureRepositories(branch) {
    await fsp.mkdir(this.workspaceDir, { recursive: true });
    
    const repos = [
      { name: "sming", url: "https://github.com/SmingHub/Sming.git" },
      { name: "esp_rgbww_firmware", url: "https://github.com/pljakobs/esp_rgbww_firmware.git" }
    ];

    for (const repo of repos) {
      const repoPath = path.join(this.workspaceDir, repo.name);
      try {
        if (!fs.existsSync(repoPath)) {
          console.log(`CrashDecoder: Cloning repository ${repo.name} from${repo.url}...`);
          execSync(`git clone ${repo.url}${repoPath}`, { stdio: "ignore" });
        }

        console.log(`CrashDecoder: Updating repository ${repo.name} and checking out branch/tag:${branch}`);
        execSync(`git -C ${repoPath} fetch origin`, { stdio: "ignore" });
        
        try {
          execSync(`git -C ${repoPath} checkout${branch}`, { stdio: "ignore" });
        } catch {
          const fallback = repo.name === "sming" ? "develop" : "main";
          console.warn(`CrashDecoder: Branch ${branch} not found in ${repo.name}, falling back to${fallback}`);
          execSync(`git -C ${repoPath} checkout${fallback}`, { stdio: "ignore" });
        }
        execSync(`git -C ${repoPath} pull`, { stdio: "ignore" });
      } catch (err) {
        console.warn(`CrashDecoder: Failed setting up repository ${repo.name}:${err.message}`);
      }
    }
  }

  /**
   * Extracts source code snippets around files and line numbers mentioned in the stack trace.
   */
  async _extractCodeSnippets(decodedText) {
    const snippets = [];
    const lineRegex = /([a-zA-Z0-9_\-\.\/]+\.(?:cpp|h|c|cc)):(\d+)/g;
    let match;
    const processedFiles = new Set();

    while ((match = lineRegex.exec(decodedText)) !== null) {
      const relPath = match[1];
      const targetLine = Number.parseInt(match[2], 10);
      const key = `${relPath}:${targetLine}`;
      if (processedFiles.has(key)) continue;
      processedFiles.add(key);

      const repos = ["esp_rgbww_firmware", "sming"];
      let absoluteFilePath = null;

      for (const repo of repos) {
        const potentialPath = path.join(this.workspaceDir, repo, relPath);
        if (fs.existsSync(potentialPath)) {
          absoluteFilePath = potentialPath;
          break;
        } else {
          try {
            const files = execSync(`find ${path.join(this.workspaceDir, repo)} -name "${path.basename(relPath)}"`, { encoding: "utf8" })
              .split("\n")
              .map(s => s.trim())
              .filter(Boolean);
            if (files.length > 0) {
              absoluteFilePath = files[0];
              break;
            }
          } catch {}
        }
      }

      if (absoluteFilePath && fs.existsSync(absoluteFilePath)) {
        try {
          const fileData = await fsp.readFile(absoluteFilePath, "utf8");
          const fileLines = fileData.split("\n");
          const start = Math.max(0, targetLine - 6);
          const end = Math.min(fileLines.length, targetLine + 5);
          const snippetLines = fileLines.slice(start, end).map((l, idx) => {
            const curLineNum = start + idx + 1;
            const marker = curLineNum === targetLine ? " >> " : "    ";
            return `${marker}${String(curLineNum).padStart(4, " ")}: ${l}`;
          });

          snippets.push(`File: ${path.relative(this.workspaceDir, absoluteFilePath)}\n\`\`\`cpp\n${snippetLines.join("\n")}\n\`\`\``);
        } catch (err) {
          console.warn(`CrashDecoder: Could not read file ${absoluteFilePath}: ${err.message}`);
        }
      }
    }

    return snippets.join("\n\n");
  }

  /**
   * Queries the Gemini API to perform technical root cause analysis.
   */
  async _analyzeWithGemini(decodedText, codeSnippets, metadata) {
    if (!this.geminiApiKey) {
      return "\n\n### Gemini AI Analysis\n*Skipped: LLS_GEMINI_API_KEY is not configured.*";
    }

    const prompt = `You are an embedded systems engineering expert analyzing a firmware crash report for an ESP8266/ESP32 IoT device built with the Sming framework.

**Device Metadata:**
- SOC: ${metadata.soc}
- Firmware Version / Branch: ${metadata.git_version}
- Build Type: ${metadata.build_type}

**Decoded Stack Trace / Crash Dump:**
\`\`\`text
${decodedText}
\`\`\`

**Relevant Source Code Context:**
${codeSnippets || "No source code snippets successfully matched."}

Please provide a technical analysis addressing:
1. **Root Cause Analysis**: The precise failure mechanism and trigger condition leading to this exception.
2. **Failure Location**: The exact functions, source files, and logical execution path responsible.
3. **Remediation**: Corrective engineering steps and code modifications required to resolve the issue permanently.`;

    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${this.geminiApiKey}`;
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }]
        }),
      });

      if (!response.ok) {
        throw new Error(`Gemini API HTTP ${response.status}: ${await response.text()}`);
      }

      const data = await response.json();
      const analysisText = data.candidates?.[0]?.content?.parts?.[0]?.text || "No response generated.";
      return `\n\n### Gemini AI Analysis\n${analysisText}`;
    } catch (err) {
      console.warn(`CrashDecoder: Gemini API analysis failed: ${err.message}`);
      return `\n\n### Gemini AI Analysis\n*Analysis generation failed: ${err.message}*`;
    }
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

    await this._ensureRepositories(branch);

    const elfUrl  = `${this.elfBaseUrl}/${branch}/${git_version}/${socKey}/${type}/${cfg.elfFile}`;
    const elfPath = path.join(this.elfCacheDir, `${git_version}-${socKey}-${type}.elf`);

    try {
      await this._ensureElf(elfUrl, elfPath);
    } catch (err) {
      const msg = `[Crash decode error: failed downloading ELF from ${elfUrl}: ${err.message}]`;
      if (this.storage && triggerRecordId) {
        await this.storage.updateCrashDecode(triggerRecordId, msg);
      }
      return;
    }

    await this._ensureScript(cfg);

    let decoded;
    try {
      decoded = await this._runDecode(cfg, elfPath, lines);
      const snippets = await this._extractCodeSnippets(decoded);
      const aiAnalysis = await this._analyzeWithGemini(decoded, snippets, { git_version, soc: socKey, build_type: type });
      decoded += aiAnalysis;
    } catch (err) {
      decoded = `[Crash decode error: ${err.message}]\n\nRaw dump:\n` + lines.join("\n");
    }

    if (this.storage && triggerRecordId) {
      await this.storage.updateCrashDecode(triggerRecordId, decoded).catch(() => {});
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
        { hostname: ip, port: 80, path: "/info?v=2", headers: { Accept: "application/json" }, timeout: 4000 },
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
            } catch { resolve(null); }
          });
        }
      );
      req.on("timeout", () => { req.destroy(); resolve(null); });
      req.on("error", () => resolve(null));
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
            file.close(() => { fs.unlink(tmpPath, () => {}); reject(new Error(`HTTP ${res.statusCode}`)); });
            return;
          }
          res.pipe(file);
          file.on("finish", () => file.close(resolve));
          file.on("error", (err) => { file.close(() => { fs.unlink(tmpPath, () => {}); reject(err); }); });
        }).on("error", (e) => { file.close(() => { fs.unlink(tmpPath, () => {}); reject(e); }); });
      });
      await fsp.chmod(tmpPath, 0o755);
      await fsp.rename(tmpPath, cfg.script);
    } catch (err) {
      console.warn(`CrashDecoder: could not download script: ${err.message}`);
    }
  }

  async _ensureElf(url, localPath, maxRedirects = 3) {
    await fsp.mkdir(path.dirname(localPath), { recursive: true });
    try { await fsp.access(localPath); return; } catch {}

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

  _runDecode(cfg, elfPath, lines) {
    return new Promise((resolve, reject) => {
      const env = {
        ...process.env,
        PATH: process.env.PATH ? `/usr/local/bin:${process.env.PATH}` : "/usr/local/bin:/usr/bin:/bin",
        SMING_SOC:  cfg.smingSOC,
        SMING_ARCH: cfg.smingArch,
      };

      const proc = spawn("python3", [cfg.script, elfPath], { env, stdio: ["pipe", "pipe", "pipe"] });

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

module.exports = { CrashDecoder, stripAnsi, extractCrashFingerprint };