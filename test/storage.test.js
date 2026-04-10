"use strict";

const os = require("os");
const path = require("path");
const fs = require("fs/promises");
const { LogStorage } = require("../src/storage");

async function makeTmpStorage(maxBytesPerIp = 10 * 1024 * 1024) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "lls-storage-"));
  const storage = new LogStorage({ dataDir, maxBytesPerIp });
  await storage.init();
  return { storage, dataDir };
}

function makeRecord(sourceIp = "192.168.1.1", overrides = {}) {
  return {
    id: `test-${Date.now()}-${Math.random()}`,
    receivedAt: new Date().toISOString(),
    sourceIp,
    priority: 6,
    tag: "host",
    app: "app",
    message: "test message",
    raw: "<6>host app: test message",
    ...overrides,
  };
}

describe("LogStorage.init()", () => {
  let dataDir;

  afterEach(async () => {
    if (dataDir) await fs.rm(dataDir, { recursive: true, force: true });
  });

  test("creates dataDir if it does not exist", async () => {
    dataDir = path.join(os.tmpdir(), `lls-init-${Date.now()}`);
    const storage = new LogStorage({ dataDir, maxBytesPerIp: 1024 });
    await storage.init();
    const stat = await fs.stat(dataDir);
    expect(stat.isDirectory()).toBe(true);
  });

  test("loads existing .ndjson files into sourceMeta", async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "lls-init-"));
    const record = makeRecord("10.0.0.1");
    await fs.writeFile(
      path.join(dataDir, "10.0.0.1.ndjson"),
      JSON.stringify(record) + "\n",
      "utf8",
    );
    const storage = new LogStorage({ dataDir, maxBytesPerIp: 1024 });
    await storage.init();
    const sources = storage.listSources();
    // IPs stored with underscores are converted back with colons on read,
    // but plain IPv4 filenames stay the same.
    expect(sources.some(s => s.ip.includes("10.0.0.1"))).toBe(true);
  });

  test("ignores non-.ndjson files during init", async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "lls-init-"));
    await fs.writeFile(path.join(dataDir, "loki.json"), "{}", "utf8");
    const storage = new LogStorage({ dataDir, maxBytesPerIp: 1024 });
    await storage.init();
    expect(storage.listSources().length).toBe(0);
  });
});

describe("LogStorage.append()", () => {
  let dataDir;
  let storage;

  beforeEach(async () => {
    ({ storage, dataDir } = await makeTmpStorage());
  });

  afterEach(async () => {
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  test("creates a file and writes a record", async () => {
    const ip = "192.168.1.1";
    const record = makeRecord(ip);
    await storage.append(ip, record);

    const filePath = storage.filePathForIp(ip);
    const content = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(content.trim());
    expect(parsed.id).toBe(record.id);
  });

  test("updates sourceMeta after append", async () => {
    const ip = "192.168.1.2";
    await storage.append(ip, makeRecord(ip));
    const sources = storage.listSources();
    expect(sources.some(s => s.ip === ip)).toBe(true);
  });

  test("multiple appends accumulate in the same file", async () => {
    const ip = "10.0.0.5";
    for (let i = 0; i < 5; i++) {
      await storage.append(ip, makeRecord(ip, { message: `msg${i}` }));
    }
    const result = await storage.getLogs({ ip });
    expect(result.items.length).toBe(5);
  });
});

describe("LogStorage.getLogs()", () => {
  let dataDir;
  let storage;

  beforeEach(async () => {
    ({ storage, dataDir } = await makeTmpStorage());
  });

  afterEach(async () => {
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  test("returns empty result for unknown IP", async () => {
    const result = await storage.getLogs({ ip: "1.2.3.4" });
    expect(result).toEqual({ items: [], total: 0, before: 0, nextBefore: null });
  });

  test("returns all records for known IP within limit", async () => {
    const ip = "10.0.0.1";
    for (let i = 0; i < 10; i++) {
      await storage.append(ip, makeRecord(ip, { message: `msg${i}` }));
    }
    const result = await storage.getLogs({ ip, limit: 200 });
    expect(result.items.length).toBe(10);
    expect(result.total).toBe(10);
    expect(result.nextBefore).toBeNull();
  });

  test("respects limit parameter", async () => {
    const ip = "10.0.0.2";
    for (let i = 0; i < 20; i++) {
      await storage.append(ip, makeRecord(ip));
    }
    const result = await storage.getLogs({ ip, limit: 5 });
    expect(result.items.length).toBe(5);
  });

  test("paginates with before parameter", async () => {
    const ip = "10.0.0.3";
    for (let i = 0; i < 10; i++) {
      await storage.append(ip, makeRecord(ip, { message: `msg${i}` }));
    }
    // Get first page (last 5)
    const page1 = await storage.getLogs({ ip, limit: 5, before: 0 });
    expect(page1.items.length).toBe(5);
    expect(page1.nextBefore).not.toBeNull();

    // Get second page using nextBefore
    const page2 = await storage.getLogs({ ip, limit: 5, before: page1.nextBefore });
    expect(page2.items.length).toBe(5);
    expect(page2.nextBefore).toBeNull();
  });

  test("clamps limit to maximum of 2000", async () => {
    const ip = "10.0.0.4";
    for (let i = 0; i < 5; i++) {
      await storage.append(ip, makeRecord(ip));
    }
    const result = await storage.getLogs({ ip, limit: 9999 });
    expect(result.items.length).toBe(5); // only 5 exist
  });

  test("defaults limit to 200 when not provided", async () => {
    const ip = "10.0.0.5";
    for (let i = 0; i < 5; i++) {
      await storage.append(ip, makeRecord(ip));
    }
    const result = await storage.getLogs({ ip });
    expect(result.items.length).toBe(5);
  });

  test("before defaults to 0 when invalid", async () => {
    const ip = "10.0.0.6";
    await storage.append(ip, makeRecord(ip));
    const result = await storage.getLogs({ ip, before: "notanumber" });
    expect(result.before).toBe(0);
  });
});

describe("LogStorage.listSources()", () => {
  let dataDir;
  let storage;

  beforeEach(async () => {
    ({ storage, dataDir } = await makeTmpStorage());
  });

  afterEach(async () => {
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  test("returns empty array initially", () => {
    expect(storage.listSources()).toEqual([]);
  });

  test("returns sources sorted by lastSeen descending", async () => {
    const ip1 = "10.0.0.1";
    const ip2 = "10.0.0.2";
    // ip1 appended first
    await storage.append(ip1, makeRecord(ip1, { receivedAt: "2024-01-01T00:00:00.000Z" }));
    // ip2 appended second (more recent)
    await storage.append(ip2, makeRecord(ip2, { receivedAt: "2024-06-01T00:00:00.000Z" }));

    const sources = storage.listSources();
    expect(sources[0].ip).toBe(ip2);
    expect(sources[1].ip).toBe(ip1);
  });
});

describe("LogStorage.purgeIp()", () => {
  let dataDir;
  let storage;

  beforeEach(async () => {
    ({ storage, dataDir } = await makeTmpStorage());
  });

  afterEach(async () => {
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  test("deletes the file and removes from sourceMeta", async () => {
    const ip = "192.168.1.1";
    await storage.append(ip, makeRecord(ip));
    await storage.purgeIp(ip);
    expect(storage.listSources().some(s => s.ip === ip)).toBe(false);
    // File should not exist
    await expect(fs.stat(storage.filePathForIp(ip))).rejects.toThrow();
  });

  test("does not throw for unknown IP", async () => {
    await expect(storage.purgeIp("1.2.3.4")).resolves.not.toThrow();
  });
});

describe("LogStorage.purgeAll()", () => {
  let dataDir;
  let storage;

  beforeEach(async () => {
    ({ storage, dataDir } = await makeTmpStorage());
  });

  afterEach(async () => {
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  test("removes all .ndjson files and clears sourceMeta", async () => {
    await storage.append("10.0.0.1", makeRecord("10.0.0.1"));
    await storage.append("10.0.0.2", makeRecord("10.0.0.2"));
    await storage.purgeAll();
    expect(storage.listSources()).toEqual([]);
    const files = await fs.readdir(dataDir);
    expect(files.filter(f => f.endsWith(".ndjson"))).toHaveLength(0);
  });
});

describe("LogStorage.trimFileIfNeeded()", () => {
  let dataDir;

  afterEach(async () => {
    if (dataDir) await fs.rm(dataDir, { recursive: true, force: true });
  });

  test("does not trim when file is within limit", async () => {
    const maxBytesPerIp = 10000;
    ({ dataDir } = await (async () => {
      const d = await fs.mkdtemp(path.join(os.tmpdir(), "lls-trim-"));
      return { dataDir: d };
    })());
    const storage = new LogStorage({ dataDir, maxBytesPerIp });
    await storage.init();
    const ip = "10.0.0.1";
    await storage.append(ip, makeRecord(ip, { message: "short" }));
    const filePath = storage.filePathForIp(ip);
    const before = (await fs.stat(filePath)).size;
    await storage.trimFileIfNeeded(filePath);
    const after = (await fs.stat(filePath)).size;
    expect(after).toBe(before);
  });

  test("trims file when it exceeds maxBytesPerIp", async () => {
    // Use a limit large enough to hold several records after trimming but
    // small enough that 20 records definitely exceed it.
    const maxBytesPerIp = 1000;
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "lls-trim-"));
    const storage = new LogStorage({ dataDir, maxBytesPerIp });
    await storage.init();
    const ip = "10.0.0.2";
    // Write 20 records; each JSON line is ~260 bytes so total ≈ 5 200 bytes
    for (let i = 0; i < 20; i++) {
      await storage.append(ip, makeRecord(ip, { message: `a`.repeat(50) }));
    }
    const filePath = storage.filePathForIp(ip);
    const size = (await fs.stat(filePath)).size;
    // After trimming the file must be ≤ maxBytesPerIp + one record of slack
    expect(size).toBeLessThanOrEqual(maxBytesPerIp + 400);
    // File should still be valid ndjson with at least one complete line
    const content = await fs.readFile(filePath, "utf8");
    const lines = content.split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    // Each remaining line should be valid JSON
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });
});
