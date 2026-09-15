"use strict";

const { extractCrashFingerprint } = require("./crashFingerprint");

/**
 * Strips ANSI color and control codes from terminal strings.
 */
function stripAnsi(text) {
  if (typeof text !== "string") return text || "";
  return text.replace(/[\u001b\u009b][\[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, "");
}

/**
 * Extracts exccause from raw crash text if the primary parser returns "unknown" or empty.
 */
function extractExccauseFallback(rawText) {
  if (!rawText) return "unknown";
  const match = rawText.match(/(?:Fatal exception|Guru Meditation Error)[^\d\n]*\(?(\d+|0x[0-9a-fa-f]+)\)?/i);
  return match ? match[1] : "unknown";
}

class CrashReporter {
  /**
   * @param {object} opts
   * @param {import('better-sqlite3').Database} opts.db
   * @param {string} [opts.githubToken]
   * @param {string} [opts.githubRepo] - "owner/repo" or full URL
   * @param {boolean} [opts.autoCreateIssues] - Toggle flag for automated issue creation
   */
  constructor({ db, githubToken, githubRepo, autoCreateIssues }) {
    this.db = db;
    this.githubToken = githubToken;
    this.githubRepo = githubRepo;
    this.autoCreateIssues = Boolean(autoCreateIssues);
  }

  async processCrash({ logId, record, decodedText }) {
    if (!this.autoCreateIssues) {
      console.log(`[CrashReporter] Crash decoded for log #${logId}, but auto-create issues is disabled.`);
      return null;
    }

    if (!this.githubToken || !this.githubRepo) {
      console.warn(`[CrashReporter] Missing GitHub token or repository configuration.`);
      return null;
    }

    // 1. Clean ANSI escape sequences from incoming trace
    const cleanDecodedText = stripAnsi(decodedText || record.message || "");

    // 2. Extract crash details
    let { exccause, pcFrame, tosFrame, fingerprint } = extractCrashFingerprint(cleanDecodedText);

    // 3. Fallback extraction if exccause resolution failed
    if (!exccause || exccause === "unknown") {
      exccause = extractExccauseFallback(cleanDecodedText);
      const pcHash = record.pcHash || "00000000";
      const stackHash = record.stackHash || "00000000";
      fingerprint = `${exccause}::${pcHash}::${stackHash}`;
    }

    // 4. Check if we already processed this fingerprint locally
    const existingLocal = this.db.prepare(
      "SELECT issue_url FROM crash_reports WHERE fingerprint = ?"
    ).get(fingerprint);

    if (existingLocal) {
      console.log(`CrashReporter: fingerprint [${fingerprint}] already filed at ${existingLocal.issue_url}`);
      return existingLocal;
    }

    // 5. Search GitHub repository for existing issue containing the fingerprint token
    const existingIssue = await this._searchGitHubIssue(fingerprint);
    if (existingIssue) {
      this._saveLocalRecord(fingerprint, logId, existingIssue.html_url, existingIssue.number, record);
      console.log(`CrashReporter: fingerprint [${fingerprint}] found in existing issue #${existingIssue.number}`);
      return existingIssue;
    }

    // 6. Create a new GitHub issue
    const newIssue = await this._createGitHubIssue({
      fingerprint,
      exccause,
      pcFrame,
      tosFrame,
      record,
      decodedText: cleanDecodedText,
    });

    if (newIssue) {
      this._saveLocalRecord(fingerprint, logId, newIssue.html_url, newIssue.number, record);
      console.log(`CrashReporter: created issue #${newIssue.number} for fingerprint [${fingerprint}]: ${newIssue.html_url}`);
    }

    return newIssue;
  }

  /**
   * Sanitizes githubRepo input to extract "owner/repo" regardless of input format.
   */
  _getCleanRepoPath() {
    return (this.githubRepo || "")
      .replace(/^https?:\/\/(www\.)?github\.com\//i, "")
      .replace(/\.git$/i, "")
      .trim();
  }

  _saveLocalRecord(fingerprint, logId, issueUrl, issueNumber, record) {
    this.db.prepare(`
      INSERT OR REPLACE INTO crash_reports 
        (fingerprint, log_id, issue_url, issue_number, soc, git_version, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      fingerprint,
      logId,
      issueUrl,
      issueNumber,
      record.soc || null,
      record.gitVersion || null,
      new Date().toISOString()
    );
  }

  async _searchGitHubIssue(fingerprint) {
    const repoPath = this._getCleanRepoPath();
    const q = encodeURIComponent(`repo:${repoPath} is:issue "${fingerprint}"`);
    const url = `https://api.github.com/search/issues?q=${q}`;

    try {
      const res = await fetch(url, {
        headers: {
          Authorization: `token ${this.githubToken}`,
          Accept: "application/vnd.github.v3+json",
          "User-Agent": "LightinatorLogService",
        },
      });

      if (!res.ok) return null;
      const data = await res.json();
      return data.items && data.items.length > 0 ? data.items[0] : null;
    } catch (err) {
      console.warn(`CrashReporter: issue search failed: ${err.message}`);
      return null;
    }
  }

  async _createGitHubIssue({ fingerprint, exccause, pcFrame, tosFrame, record, decodedText }) {
    const repoPath = this._getCleanRepoPath();
    const url = `https://api.github.com/repos/${repoPath}/issues`;

    const titleLocation = pcFrame || `Cause ${exccause}`;
    const title = `Crash: ${titleLocation} [${fingerprint}]`;

    const body = [
      `### Firmware Crash Report [${fingerprint}]`,
      ``,
      `**Device Metadata:**`,
      `- **SOC:** ${record.soc || "Unknown"}`,
      `- **Git Version:** ${record.gitVersion || "Unknown"}`,
      `- **Build Type:** ${record.buildType || "Unknown"}`,
      `- **Source IP:** ${record.sourceIp || record.ip || "Unknown"}`,
      ``,
      `**Top Call Frames:**`,
      `- **PC:** \`${pcFrame || "Unknown"}\``,
      `- **TOS:** \`${tosFrame || "Unknown"}\``,
      ``,
      `### Decoded Stacktrace`,
      `\`\`\`text`,
      decodedText,
      `\`\`\``,
    ].join("\n");

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `token ${this.githubToken}`,
          Accept: "application/vnd.github.v3+json",
          "Content-Type": "application/json",
          "User-Agent": "LightinatorLogService",
        },
        body: JSON.stringify({ title, body, labels: ["crash-report"] }),
      });

      if (!res.ok) {
        const errorText = await res.text();
        console.warn(`CrashReporter: issue creation failed HTTP ${res.status}: ${errorText}`);
        return null;
      }

      return await res.json();
    } catch (err) {
      console.warn(`CrashReporter: failed creating GitHub issue: ${err.message}`);
      return null;
    }
  }
}

module.exports = { CrashReporter, stripAnsi, extractExccauseFallback };