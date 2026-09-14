"use strict";

const { extractCrashFingerprint } = require("./crashFingerprint");

class CrashReporter {
  /**
   * @param {object} opts
   * @param {import('better-sqlite3').Database} opts.db
   * @param {string} [opts.githubToken]
   * @param {string} [opts.githubRepo] - "owner/repo"
   */
  constructor({ db, githubToken, githubRepo }) {
    this.db = db;
    this.githubToken = githubToken;
    this.githubRepo = githubRepo;
  }

  async processCrash({ logId, record, decodedText }) {
    if (!this.githubToken || !this.githubRepo) {
      return;
    }

    const { exccause, pcFrame, tosFrame, fingerprint } = extractCrashFingerprint(decodedText);

    // Check if we already processed this fingerprint locally
    const existingLocal = this.db.prepare(
      "SELECT issue_url FROM crash_reports WHERE fingerprint = ?"
    ).get(fingerprint);

    if (existingLocal) {
      console.log(`CrashReporter: fingerprint [${fingerprint}] already filed at ${existingLocal.issue_url}`);
      return;
    }

    // Search GitHub repository for existing issue containing the fingerprint token
    const existingIssue = await this._searchGitHubIssue(fingerprint);
    if (existingIssue) {
      this._saveLocalRecord(fingerprint, logId, existingIssue.html_url, existingIssue.number, record);
      console.log(`CrashReporter: fingerprint [${fingerprint}] found in existing issue #${existingIssue.number}`);
      return;
    }

    // Create a new GitHub issue
    const newIssue = await this._createGitHubIssue({
      fingerprint,
      exccause,
      pcFrame,
      tosFrame,
      record,
      decodedText,
    });

    if (newIssue) {
      this._saveLocalRecord(fingerprint, logId, newIssue.html_url, newIssue.number, record);
      console.log(`CrashReporter: created issue #${newIssue.number} for fingerprint [${fingerprint}]`);
    }
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
    const q = encodeURIComponent(`repo:${this.githubRepo} is:issue "${fingerprint}"`);
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
    const url = `https://api.github.com/repos/${this.githubRepo}/issues`;

    const titleLocation = pcFrame || `Cause ${exccause}`;
    const title = `Crash: ${titleLocation} [${fingerprint}]`;

    const body = [
      `### Firmware Crash Report [${fingerprint}]`,
      ``,
      `**Device Metadata:**`,
      `- **SOC:** ${record.soc || "Unknown"}`,
      `- **Git Version:** ${record.gitVersion || "Unknown"}`,
      `- **Build Type:** ${record.buildType || "Unknown"}`,
      `- **Source IP:** ${record.sourceIp || "Unknown"}`,
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

module.exports = { CrashReporter };