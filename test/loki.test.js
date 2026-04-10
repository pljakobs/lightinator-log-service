"use strict";

const os = require("os");
const path = require("path");
const fs = require("fs/promises");
const { LokiForwarder } = require("../src/loki");

async function makeTmpForwarder(extraConfig = {}) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "lls-loki-"));
  const configPath = path.join(tmpDir, "loki.json");
  const forwarder = new LokiForwarder({ configPath });
  return { forwarder, configPath, tmpDir };
}

describe("LokiForwarder initial state", () => {
  let tmpDir;
  let forwarder;

  beforeEach(async () => {
    ({ forwarder, tmpDir } = await makeTmpForwarder());
  });

  afterEach(async () => {
    forwarder.stop();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test("getStatus returns disabled state initially", () => {
    const status = forwarder.getStatus();
    expect(status.state).toBe("disabled");
    expect(status.lastPushAt).toBeNull();
    expect(status.lastError).toBeNull();
    expect(status.pushed).toBe(0);
  });

  test("getConfig returns url and enabled flag", () => {
    const cfg = forwarder.getConfig();
    expect(typeof cfg.url).toBe("string");
    expect(typeof cfg.enabled).toBe("boolean");
  });

  test("getConfig masks password", async () => {
    await forwarder.loadConfig();
    const cfg = forwarder.getConfig();
    // Password is empty by default — should return empty string not the mask
    expect(cfg.password).toBe("");
  });
});

describe("LokiForwarder.loadConfig()", () => {
  let tmpDir;
  let forwarder;
  let configPath;

  beforeEach(async () => {
    ({ forwarder, configPath, tmpDir } = await makeTmpForwarder());
  });

  afterEach(async () => {
    forwarder.stop();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test("loads successfully when config file does not exist (no throw)", async () => {
    await expect(forwarder.loadConfig()).resolves.not.toThrow();
  });

  test("loads enabled and url from config file", async () => {
    await fs.writeFile(
      configPath,
      JSON.stringify({ enabled: true, url: "http://loki.example.com:3100" }),
      "utf8",
    );
    await forwarder.loadConfig();
    const cfg = forwarder.getConfig();
    expect(cfg.enabled).toBe(true);
    expect(cfg.url).toBe("http://loki.example.com:3100");
  });

  test("merges with defaults for missing fields", async () => {
    await fs.writeFile(configPath, JSON.stringify({ enabled: true }), "utf8");
    await forwarder.loadConfig();
    const cfg = forwarder.getConfig();
    expect(cfg.enabled).toBe(true);
    // url should have the default value
    expect(typeof cfg.url).toBe("string");
  });
});

describe("LokiForwarder.saveConfig()", () => {
  let tmpDir;
  let forwarder;
  let configPath;

  beforeEach(async () => {
    ({ forwarder, configPath, tmpDir } = await makeTmpForwarder());
    await forwarder.loadConfig();
  });

  afterEach(async () => {
    forwarder.stop();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test("saves enabled and url to disk", async () => {
    await forwarder.saveConfig({ enabled: true, url: "http://new-loki:3100" });
    const raw = await fs.readFile(configPath, "utf8");
    const parsed = JSON.parse(raw);
    expect(parsed.enabled).toBe(true);
    expect(parsed.url).toBe("http://new-loki:3100");
  });

  test("does not overwrite password when sentinel mask is provided", async () => {
    await forwarder.saveConfig({ password: "secretpassword" });
    await forwarder.saveConfig({ password: "••••••••" });
    const raw = await fs.readFile(configPath, "utf8");
    const parsed = JSON.parse(raw);
    expect(parsed.password).toBe("secretpassword");
  });

  test("updates password when non-mask value provided", async () => {
    await forwarder.saveConfig({ password: "newpassword" });
    const raw = await fs.readFile(configPath, "utf8");
    const parsed = JSON.parse(raw);
    expect(parsed.password).toBe("newpassword");
  });

  test("getConfig masks non-empty password with bullets", async () => {
    await forwarder.saveConfig({ password: "somepassword" });
    const cfg = forwarder.getConfig();
    expect(cfg.password).toBe("••••••••");
  });
});

describe("LokiForwarder.forward()", () => {
  let tmpDir;
  let forwarder;

  beforeEach(async () => {
    ({ forwarder, tmpDir } = await makeTmpForwarder());
    await forwarder.loadConfig();
  });

  afterEach(async () => {
    forwarder.stop();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test("does not buffer when disabled", () => {
    forwarder.config.enabled = false;
    forwarder.forward({ message: "test", sourceIp: "1.2.3.4", receivedAt: new Date().toISOString() });
    expect(forwarder._buffer.length).toBe(0);
  });

  test("buffers records when enabled", () => {
    forwarder.config.enabled = true;
    forwarder.forward({ message: "test", sourceIp: "1.2.3.4", receivedAt: new Date().toISOString() });
    expect(forwarder._buffer.length).toBe(1);
  });
});

describe("LokiForwarder._resolveLabels()", () => {
  let tmpDir;
  let forwarder;

  beforeEach(async () => {
    ({ forwarder, tmpDir } = await makeTmpForwarder());
    await forwarder.loadConfig();
  });

  afterEach(async () => {
    forwarder.stop();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test("returns global labels for unknown IP", () => {
    forwarder.config.labels = { job: "lightinator" };
    const labels = forwarder._resolveLabels("1.2.3.4");
    expect(labels).toEqual({ job: "lightinator" });
  });

  test("merges controller-specific labels over globals", () => {
    forwarder.config.labels = { job: "lightinator" };
    forwarder.config.controllers = {
      "1.2.3.4": { labels: { controller_name: "kitchen" }, group: "" },
    };
    const labels = forwarder._resolveLabels("1.2.3.4");
    expect(labels.job).toBe("lightinator");
    expect(labels.controller_name).toBe("kitchen");
  });

  test("merges group labels between globals and controller-specific", () => {
    forwarder.config.labels = { job: "lightinator" };
    forwarder.config.groups = { living: { room: "living" } };
    forwarder.config.controllers = {
      "1.2.3.4": { labels: { controller_name: "tv" }, group: "living" },
    };
    const labels = forwarder._resolveLabels("1.2.3.4");
    expect(labels.job).toBe("lightinator");
    expect(labels.room).toBe("living");
    expect(labels.controller_name).toBe("tv");
  });
});

describe("LokiForwarder._buildPayload()", () => {
  let tmpDir;
  let forwarder;

  beforeEach(async () => {
    ({ forwarder, tmpDir } = await makeTmpForwarder());
    await forwarder.loadConfig();
    forwarder.config.labels = { job: "lightinator" };
  });

  afterEach(async () => {
    forwarder.stop();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test("groups records from the same source into one stream", () => {
    const records = [
      { sourceIp: "1.2.3.4", tag: "host", message: "a", receivedAt: "2024-01-01T00:00:00.000Z" },
      { sourceIp: "1.2.3.4", tag: "host", message: "b", receivedAt: "2024-01-01T00:00:01.000Z" },
    ];
    const payload = forwarder._buildPayload(records);
    expect(payload.streams.length).toBe(1);
    expect(payload.streams[0].values.length).toBe(2);
  });

  test("separates records from different sources into different streams", () => {
    const records = [
      { sourceIp: "1.2.3.4", tag: "host1", message: "a", receivedAt: "2024-01-01T00:00:00.000Z" },
      { sourceIp: "1.2.3.5", tag: "host2", message: "b", receivedAt: "2024-01-01T00:00:01.000Z" },
    ];
    const payload = forwarder._buildPayload(records);
    expect(payload.streams.length).toBe(2);
  });

  test("each value is a [nanoTimestamp, message] pair", () => {
    const receivedAt = "2024-06-01T12:00:00.000Z";
    const records = [
      { sourceIp: "1.2.3.4", tag: "host", message: "hello", receivedAt },
    ];
    const payload = forwarder._buildPayload(records);
    const [tsNs, msg] = payload.streams[0].values[0];
    expect(typeof tsNs).toBe("string");
    expect(BigInt(tsNs)).toBeGreaterThan(0n);
    expect(msg).toBe("hello");
  });

  test("falls back to raw when message is empty", () => {
    const records = [
      { sourceIp: "1.2.3.4", tag: "host", message: "", raw: "raw fallback", receivedAt: "2024-01-01T00:00:00.000Z" },
    ];
    const payload = forwarder._buildPayload(records);
    expect(payload.streams[0].values[0][1]).toBe("raw fallback");
  });
});

describe("LokiForwarder.stop()", () => {
  test("stop() clears internal timer without throwing", async () => {
    const { forwarder, tmpDir } = await makeTmpForwarder();
    await forwarder.loadConfig();
    forwarder.config.enabled = true;
    forwarder.config.flushIntervalMs = 60000;
    forwarder._restartTimer();
    expect(() => forwarder.stop()).not.toThrow();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });
});
