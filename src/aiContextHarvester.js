/**
 * aiContextHarvester.js
 * 
 * Handles repository synchronization (Sming, esp-rgbww-firmware), map file retrieval,
 * and source code context extraction around stack trace fault locations and targeted JSON requests asynchronously.
 */

"use strict";

const fs = require("fs/promises");
const path = require("path");
const { execFile } = require("child_process");
const util = require("util");
const execFileAsync = util.promisify(execFile);
const http = require("http");
const https = require("https");

class AIContextHarvester {
  constructor({ cacheDir, elfBaseUrl }) {
    this.cacheDir = cacheDir || path.join(process.cwd(), "data", "context_cache");
    this.elfBaseUrl = elfBaseUrl || "http://lightinator.de/download";
  }

  async init() {
    await fs.mkdir(this.cacheDir, { recursive: true });
  }

  /**
   * Clones or updates a repository and checks out a specific branch, tag, or commit reference asynchronously.
   */
  async ensureRepo(name, repoUrl, ref) {
    if (!/^[a-zA-Z0-9_.-]+$/.test(name) || name === "." || name === "..") {
      throw new Error("Invalid repository name");
    }
    const repoPath = path.join(this.cacheDir, name);
    const targetRef = ref || "develop";
    const effectiveUrl = repoUrl || (name === "Sming" ? "https://github.com/pljakobs/Sming.git" : repoUrl);
    if (typeof targetRef !== "string" || targetRef.startsWith("-") || /[\r\n\0]/.test(targetRef)) {
      throw new Error("Invalid repository reference");
    }
    if (typeof effectiveUrl !== "string" || !/^(?:https?|file):\/\//.test(effectiveUrl)) {
      throw new Error("Unsupported repository URL");
    }
    const git = args => execFileAsync("git", args, {
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });

    try {
      await fs.access(repoPath);
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
      await fs.mkdir(this.cacheDir, { recursive: true });
      await git(["clone", "--depth", "50", "--", effectiveUrl, repoPath]);
    }
    await git(["-C", repoPath, "fetch", "origin", "--tags"]);
    let revision;
    try {
      revision = await git(["-C", repoPath, "rev-parse", "--verify", "--end-of-options", `${targetRef}^{commit}`]);
    } catch {
      revision = await git(["-C", repoPath, "rev-parse", "--verify", "--end-of-options", `refs/remotes/origin/${targetRef}^{commit}`]);
    }
    const { stdout } = revision;
    const commit = stdout.trim();
    if (!/^[0-9a-f]{40,64}$/.test(commit)) throw new Error("Invalid repository commit");
    await git(["-C", repoPath, "checkout", "--detach", commit]);
    await git(["-C", repoPath, "submodule", "update", "--init", "--recursive"]);
    return repoPath;
  }

  /**
   * Downloads the .map file corresponding to a firmware build.
   */
  async fetchMapFile(gitVersion, soc, buildType = "debug") {
    const socKey = soc.toLowerCase();
    const mapFileName = socKey === "esp8266" ? "app_0.map" : "app.map";
    const cacheKey = [gitVersion, socKey, buildType].map(value => encodeURIComponent(value)).join("-");
    const localPath = path.join(this.cacheDir, `${cacheKey}-${mapFileName}`);
    
    try {
      return await fs.readFile(localPath, "utf8");
    } catch {
      const vMatch = gitVersion.match(/^V[\d.]+-\d+-(.+)$/i);
      const branch = vMatch ? vMatch[1] : "develop";
      const url = `${this.elfBaseUrl}/${[branch, gitVersion, socKey, buildType, mapFileName].map(value => encodeURIComponent(value)).join("/")}`;
      
      try {
        const data = await this.downloadUrl(url);
        await fs.mkdir(this.cacheDir, { recursive: true });
        await fs.writeFile(localPath, data, "utf8");
        return data;
      } catch (err) {
        console.warn(`[AIContextHarvester] Could not fetch map file from ${url}:${err.message}`);
        return null;
      }
    }
  }

  downloadUrl(url) {
    return new Promise((resolve, reject) => {
      const client = url.startsWith("https") ? https : http;
      client.get(url, (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP status code ${res.statusCode}`));
          return;
        }
        let data = "";
        res.on("data", chunk => data += chunk);
        res.on("end", () => resolve(data));
      }).on("error", reject);
    });
  }

  /**
   * Scans decoded crash text for file paths and line numbers, extracting code snippets.
   */
  async extractSnippets(decodedText, repoPaths) {
    const snippets = [];
    const regex = /([a-zA-Z0-9_.\-\/]+\.(cpp|cc|cxx|c|h|hpp|s)):(\d+)/gi;
    const cleanText = decodedText.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
    let match;
    const seen = new Set();

    while ((match = regex.exec(cleanText)) !== null) {
      const filePath = match[1];
      const lineNum = Number.parseInt(match[3], 10);
      const key = `${filePath}:${lineNum}`;
      if (seen.has(key)) continue;
      seen.add(key);

      for (const [repoName, baseDir] of Object.entries(repoPaths)) {
        const absolutePath = await this._resolveSourceFile(baseDir, filePath);
        if (!absolutePath) continue;
        try {
          const content = await fs.readFile(absolutePath, "utf8");
          const lines = content.split("\n");
          const start = Math.max(0, lineNum - 12);
          const end = Math.min(lines.length, lineNum + 12);
          const snippet = lines.slice(start, end).map((l, idx) => `${start + idx + 1}:${l}`).join("\n");
          
          snippets.push({
            repo: repoName,
            file: filePath,
            targetLine: lineNum,
            snippet,
          });
          break;
        } catch {
          // File not found in this repo, check next
        }
      }
    }
    return snippets;
  }

  async _resolveSourceFile(baseDir, filePath) {
    if (typeof filePath !== "string" || filePath.includes("\0")) return null;
    const parts = filePath.split("/").filter(Boolean);
    if (parts.includes("..")) return null;
    let root;
    try {
      root = await fs.realpath(baseDir);
    } catch {
      return null;
    }
    for (let offset = 0; offset < parts.length; offset++) {
      const candidate = path.resolve(root, ...parts.slice(offset));
      if (!candidate.startsWith(root + path.sep)) continue;
      try {
        const resolved = await fs.realpath(candidate);
        if (resolved.startsWith(root + path.sep) && (await fs.stat(resolved)).isFile()) return resolved;
      } catch {}
    }
    return null;
  }

  /**
   * Extracts specific file ranges requested via JSON from Pass 1 analysis.
   */
  async getContextFiles(fileRequests, repoPaths, { maxBytes = 120_000 } = {}) {
    const snippets = [];
    let remaining = maxBytes;
    if (!Array.isArray(fileRequests)) return snippets;

    for (const req of fileRequests) {
      const requestedPath = req?.path || req?.file;
      if (typeof requestedPath !== "string") continue;
      let found = false;
      for (const [repoName, baseDir] of Object.entries(repoPaths)) {
        const candidate = await this._resolveSourceFile(baseDir, requestedPath);
        if (candidate) {
          try {
            const content = await fs.readFile(candidate, "utf8");
            const lines = content.split("\n");
            const start = req.full_file === true ? 0 : Math.max(0, (Number(req.start_line ?? req.startLine) || 1) - 1);
            const end = req.full_file === true ? lines.length : Math.min(lines.length, Number(req.end_line ?? req.stopLine) || start + 200);
            if (start >= end) continue;
            const snippet = lines.slice(start, end).map((line, index) => `${start + index + 1}:${line}`).join("\n");
            const size = Buffer.byteLength(snippet, "utf8");
            if (size > remaining) continue;
            remaining -= size;

            snippets.push({
              repo: repoName,
              file: req.name || path.basename(candidate),
              path: requestedPath,
              startLine: start + 1,
              stopLine: end,
              snippet,
            });
            found = true;
            break;
          } catch {
            // Try next candidate path
          }
        }
        if (found) break;
      }

      if (!found) {
        console.warn(`[AIContextHarvester] Requested context file not found: ${requestedPath}`);
      }
    }
    return snippets;
  }
}

module.exports = { AIContextHarvester };