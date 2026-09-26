"use strict";

const { extractCrashFingerprint } = require("./crashFingerprint");

function stripAnsi(text) {
  if (typeof text !== "string") return text || "";
  return text.replace(/[\u001b\u009b][\[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, "");
}

function extractExccauseFallback(rawText) {
  if (!rawText) return "unknown";
  const match = rawText.match(/(?:Fatal exception|Guru Meditation Error)[^\d\n]*\(?(\d+|0x[0-9a-fa-f]+)\)?/i);
  return match ? match[1] : "unknown";
}

class CrashReporter {
  constructor({ db, githubToken, githubRepo, autoCreateIssues }) {
    this.db = db;
    this.githubToken = githubToken;
    this.githubRepo = githubRepo;
    this.autoCreateIssues = Boolean(autoCreateIssues);
  }

  async processCrash({ logId, record, decodedText }) {
    if (!this.autoCreateIssues) return null;
    if (!this.githubToken || !this.githubRepo) return null;

    const cleanDecodedText = stripAnsi(decodedText || record.message || "");
    let { exccause, pcFrame, tosFrame, fingerprint } = extractCrashFingerprint(cleanDecodedText);

    if (!exccause || exccause === "unknown") {
      exccause = extractExccauseFallback(cleanDecodedText);
      const pcHash = record.pcHash || "00000000";
      const stackHash = record.stackHash || "00000000";
      fingerprint = `${exccause}::${pcHash}::${stackHash}`;
    }

    const existingLocal = this.db.prepare(
      "SELECT issue_url FROM crash_reports WHERE fingerprint = ?"
    ).get(fingerprint);

    if (existingLocal) return existingLocal;

    const existingIssue = await this._searchGitHubIssue(fingerprint);
    if (existingIssue) {
      this._saveLocalRecord(fingerprint, logId, existingIssue.html_url, existingIssue.number, record);
      return existingIssue;
    }

    const newIssue = await this._createGitHubIssue({
      fingerprint,
      exccause,
      pcFrame,
      tosFrame,
      record,
      decodedText: cleanDecodedText,
      aiAnalysis: record.aiAnalysis || null,
    });

    if (newIssue) {
      this._saveLocalRecord(fingerprint, logId, newIssue.html_url, newIssue.number, record);
    }

    return newIssue;
  }

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
      return null;
    }
  }

  async _createGitHubIssue({ fingerprint, exccause, pcFrame, tosFrame, record, decodedText, aiAnalysis }) {
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
      aiAnalysis ? `### AI Root-Cause & Remediation Analysis\n${aiAnalysis}\n` : "",
      `### Decoded Stacktrace`,
      `\`\`\`text`,
      decodedText,
      `\`\`\``,
    ].filter(Boolean).join("\n");

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `token ${this.githubToken}`,
          Accept: "application/vnd.github.v3+json",
          "Content-Type": "application/json",
          "User-Agent": "LightinatorLogService",
        },
        body: JSON.stringify({ title, body, labels: ["crash-report", "ai-analyzed"] }),
      });

      if (!res.ok) return null;
      return await res.json();
    } catch (err) {
      return null;
    }
  }
}

module.exports = { CrashReporter, stripAnsi, extractExccauseFallback };