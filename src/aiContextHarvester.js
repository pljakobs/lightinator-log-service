/**
 * aiContextHarvester.js
 * 
 * Handles repository synchronization (Sming, esp-rgbww-firmware), map file retrieval,
 * and source code context extraction around stack trace fault locations and targeted JSON requests.
 */

"use strict";

const fs = require("fs/promises");
const path = require("path");
const { execSync } = require("child_process");
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
   * Clones or updates a repository and checks out a specific branch, tag, or commit reference.
   */
async ensureRepo(name, repoUrl, ref) {
    const repoPath = path.join(this.cacheDir, name);
    const targetRef = ref || "develop";
    const effectiveUrl = repoUrl || (name === "Sming" ? "https://github.com/pljakobs/Sming.git" : repoUrl);

    try {
      // If the cache directory already exists, fetch updates, checkout reference, and sync submodules
      await fs.access(repoPath);
      execSync(`git -C "${repoPath}" fetch origin --tags`, { stdio: "ignore" });
      execSync(`git -C "${repoPath}" checkout "${targetRef}"`, { stdio: "ignore" });
      execSync(`git -C "${repoPath}" submodule update --init --recursive`, { stdio: "ignore" });
    } catch {
      // If missing, initialize a clean clone, fetch tags, checkout, and populate submodules
      await fs.mkdir(repoPath, { recursive: true });
      execSync(`git clone --depth 50 "${effectiveUrl}" "${repoPath}"`, { stdio: "ignore" });
      execSync(`git -C "${repoPath}" fetch origin --tags`, { stdio: "ignore" });
      execSync(`git -C "${repoPath}" checkout "${targetRef}"`, { stdio: "ignore" });
      execSync(`git -C "${repoPath}" submodule update --init --recursive`, { stdio: "ignore" });
    }
    return repoPath;
  }

  /**
   * Downloads the .map file corresponding to a firmware build.
   */
  async fetchMapFile(gitVersion, soc, buildType = "debug") {
    const mapFileName = `firmware_${soc}_${gitVersion}.map`;
    const localPath = path.join(this.cacheDir, mapFileName);
    
    try {
      return await fs.readFile(localPath, "utf8");
    } catch {
      const vMatch = gitVersion.match(/^V[\d.]+-\d+-(.+)$/i);
      const branch = vMatch ? vMatch[1] : "develop";
      const url = `${this.elfBaseUrl}/${branch}/${gitVersion}/${soc}/${buildType}/${mapFileName}`;
      
      try {
        const data = await this.downloadUrl(url);
        await fs.writeFile(localPath, data, "utf8");
        return data;
      } catch (err) {
        console.warn(`[AIContextHarvester] Could not fetch map file from ${url}: ${err.message}`);
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
    const regex = /([a-zA-Z0-9_\-\/]+\.(cpp|c|h|hpp)):(\d+)/g;
    let match;
    const seen = new Set();

    while ((match = regex.exec(decodedText)) !== null) {
      const filePath = match[1];
      const lineNum = Number.parseInt(match[3], 10);
      const key = `${filePath}:${lineNum}`;
      if (seen.has(key)) continue;
      seen.add(key);

      for (const [repoName, baseDir] of Object.entries(repoPaths)) {
        const absolutePath = path.join(baseDir, filePath);
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

  /**
   * Extracts specific file ranges requested via JSON from Pass 1 analysis.
   * Handles absolute container/vm paths (e.g., /opt/Sming/...) and maps them to local repo caches.
   */
  async getContextFiles(fileRequests, repoPaths) {
    const snippets = [];
    if (!Array.isArray(fileRequests)) return snippets;

    for (const req of fileRequests) {
      // Normalize path by stripping container-specific absolute prefixes
      let relPath = req.path.replace(/^\/(opt|home|root|app)\/[^\/]+\//, '');
      if (relPath.startsWith('/')) {
        relPath = relPath.substring(1);
      }

      let found = false;
      for (const [repoName, baseDir] of Object.entries(repoPaths)) {
        const candidatePaths = [
          path.join(baseDir, relPath),
          path.join(baseDir, relPath.replace(new RegExp(`^${repoName}\/*`), '')),
        ];

        for (const candidate of candidatePaths) {
          try {
            const content = await fs.readFile(candidate, "utf8");
            const lines = content.split("\n");
            const start = Math.max(0, (req.startLine || 1) - 1);
            const end = Math.min(lines.length, req.stopLine || lines.length);
            const snippet = lines.slice(start, end).map((l, idx) => `${start + idx + 1}:${l}`).join("\n");

            snippets.push({
              repo: repoName,
              file: req.name || path.basename(candidate),
              path: req.path,
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
        console.warn(`[AIContextHarvester] Requested context file not found: ${req.path}`);
      }
    }
    return snippets;
  }
}

module.exports = { AIContextHarvester };