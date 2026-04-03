const fs = require("fs/promises");
const path = require("path");

function ipToFileName(ip) {
  return String(ip).replace(/[^a-zA-Z0-9.-]/g, "_") + ".ndjson";
}

class LogStorage {
  constructor({ dataDir, maxBytesPerIp }) {
    this.dataDir = dataDir;
    this.maxBytesPerIp = maxBytesPerIp;
    this.sourceMeta = new Map();
  }

  async init() {
    await fs.mkdir(this.dataDir, { recursive: true });
    const files = await fs.readdir(this.dataDir);
    for (const file of files) {
      if (!file.endsWith(".ndjson")) continue;
      const sourceIp = file.replace(/\.ndjson$/, "").replace(/_/g, ":");
      const fullPath = path.join(this.dataDir, file);
      const stats = await fs.stat(fullPath);
      this.sourceMeta.set(sourceIp, {
        ip: sourceIp,
        bytes: stats.size,
        entries: null,
        lastSeen: stats.mtime.toISOString(),
      });
    }
  }

  filePathForIp(ip) {
    return path.join(this.dataDir, ipToFileName(ip));
  }

  async append(ip, record) {
    const filePath = this.filePathForIp(ip);
    const line = JSON.stringify(record) + "\n";
    await fs.appendFile(filePath, line, "utf8");
    await this.trimFileIfNeeded(filePath);

    const stats = await fs.stat(filePath);
    this.sourceMeta.set(ip, {
      ip,
      bytes: stats.size,
      entries: null,
      lastSeen: record.receivedAt,
    });
  }

  async trimFileIfNeeded(filePath) {
    const stats = await fs.stat(filePath);
    if (stats.size <= this.maxBytesPerIp) return;

    const handle = await fs.open(filePath, "r");
    try {
      const toKeep = this.maxBytesPerIp;
      const start = Math.max(0, stats.size - toKeep);
      const buf = Buffer.alloc(stats.size - start);
      await handle.read(buf, 0, buf.length, start);

      let content = buf.toString("utf8");
      const firstNewline = content.indexOf("\n");
      if (firstNewline !== -1) {
        content = content.slice(firstNewline + 1);
      }
      await fs.writeFile(filePath, content, "utf8");
    } finally {
      await handle.close();
    }
  }

  listSources() {
    return Array.from(this.sourceMeta.values()).sort((a, b) => {
      if (!a.lastSeen) return 1;
      if (!b.lastSeen) return -1;
      return b.lastSeen.localeCompare(a.lastSeen);
    });
  }

  async getLogs({ ip, limit = 200, before = 0 }) {
    const filePath = this.filePathForIp(ip);

    let content;
    try {
      content = await fs.readFile(filePath, "utf8");
    } catch (err) {
      if (err.code === "ENOENT") {
        return { items: [], total: 0, before, nextBefore: null };
      }
      throw err;
    }

    const lines = content
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    const total = lines.length;
    const safeBefore = Math.max(0, Number.parseInt(before, 10) || 0);
    const safeLimit = Math.max(1, Math.min(2000, Number.parseInt(limit, 10) || 200));

    const end = Math.max(0, total - safeBefore);
    const start = Math.max(0, end - safeLimit);
    const page = lines.slice(start, end).map((line) => JSON.parse(line));

    const hasMoreOlder = start > 0;
    return {
      items: page,
      total,
      before: safeBefore,
      nextBefore: hasMoreOlder ? safeBefore + page.length : null,
    };
  }

  async purgeIp(ip) {
    const filePath = this.filePathForIp(ip);
    await fs.rm(filePath, { force: true });
    this.sourceMeta.delete(ip);
  }

  async purgeAll() {
    const files = await fs.readdir(this.dataDir);
    await Promise.all(
      files
        .filter((file) => file.endsWith(".ndjson"))
        .map((file) => fs.rm(path.join(this.dataDir, file), { force: true })),
    );
    this.sourceMeta.clear();
  }
}

module.exports = { LogStorage };
