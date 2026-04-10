"use strict";

/**
 * Integration tests for the Express API routes defined in src/index.js.
 *
 * We extract the app-creation logic into a helper that builds an express app
 * with real (but tmp-dir-backed) storage and mock Loki/discovery instances so
 * no real network calls are made.
 */

const os = require("os");
const path = require("path");
const fs = require("fs/promises");
const request = require("supertest");
const express = require("express");
const cors = require("cors");

const { LogStorage } = require("../src/storage");
const { LokiForwarder } = require("../src/loki");
const { ControllerDiscovery } = require("../src/discovery");
const { SETTINGS_SCHEMA, readServiceEnv, writeServiceEnv } = require("../src/serviceConfig");

// ── Build a minimal Express app wired up like src/index.js ────────────────────

async function buildTestApp() {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "lls-api-test-"));
  const dataDir = path.join(tmpDir, "logs");
  const lokiConfigPath = path.join(tmpDir, "loki.json");
  const serviceEnvPath = path.join(tmpDir, "service.env");

  const storage = new LogStorage({ dataDir, maxBytesPerIp: 1024 * 1024 });
  await storage.init();

  const loki = new LokiForwarder({ configPath: lokiConfigPath });
  await loki.loadConfig();

  const discovery = new ControllerDiscovery({
    seedHosts: [],
    refreshIntervalMs: 0,
    statePath: null,
  });

  function cleanup() {
    loki.stop();
    discovery.stop();
  }

  const app = express();
  app.use(cors());
  app.use(express.json({ limit: "1mb" }));

  // ── Health ────────────────────────────────────────────────────────────────
  app.get("/health", (_req, res) => {
    res.json({ status: "ok", service: "test", version: "0.0.0-test", uptimeSec: 0 });
  });

  app.get("/api/v1/health", (_req, res) => {
    res.json({ status: "ok", version: "0.0.0-test" });
  });

  // ── Sources & Logs ────────────────────────────────────────────────────────
  app.get("/api/v1/sources", (_req, res) => {
    res.json({ items: storage.listSources() });
  });

  app.get("/api/v1/logs", async (req, res, next) => {
    try {
      const ip = String(req.query.ip || "").trim();
      if (!ip) {
        return res.status(400).json({ error: "Missing required query parameter: ip" });
      }
      const result = await storage.getLogs({ ip, limit: req.query.limit, before: req.query.before });
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  app.delete("/api/v1/logs", async (req, res, next) => {
    try {
      const ip = String(req.query.ip || "").trim();
      if (ip) {
        await storage.purgeIp(ip);
        return res.json({ ok: true, purged: "ip", ip });
      }
      const all = String(req.query.all || "").toLowerCase() === "true";
      if (!all) {
        return res.status(400).json({ error: "Provide ip=<address> or all=true" });
      }
      await storage.purgeAll();
      res.json({ ok: true, purged: "all" });
    } catch (err) {
      next(err);
    }
  });

  // ── Loki ──────────────────────────────────────────────────────────────────
  app.get("/api/v1/loki/status", (_req, res) => {
    res.json(loki.getStatus());
  });

  app.get("/api/v1/loki/config", (_req, res) => {
    res.json(loki.getConfig());
  });

  app.put("/api/v1/loki/config", async (req, res, next) => {
    try {
      const { enabled, url, username, password, labels, groups, controllers, batchSize, flushIntervalMs } = req.body;
      if (url) {
        try { new URL(url); } catch {
          return res.status(400).json({ error: "Invalid Loki URL" });
        }
      }
      await loki.saveConfig({ enabled, url, username, password, labels, groups, controllers, batchSize, flushIntervalMs });
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  // ── Service config ────────────────────────────────────────────────────────
  app.get("/api/v1/service-config", async (_req, res) => {
    try {
      const values = await readServiceEnv(serviceEnvPath);
      res.json({ schema: SETTINGS_SCHEMA, values, liveValues: {} });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/v1/service-config", async (req, res) => {
    try {
      const values = req.body.values || {};
      await writeServiceEnv(serviceEnvPath, values);
      res.json({ ok: true, restartRequired: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Controllers ───────────────────────────────────────────────────────────
  app.get("/api/v1/controllers", (_req, res) => {
    res.json({ items: discovery.getAll() });
  });

  app.patch("/api/v1/controllers/:ip/logging", async (req, res) => {
    const ip = req.params.ip;
    const { enabled } = req.body;
    if (typeof enabled !== "boolean") {
      return res.status(400).json({ error: "enabled must be boolean" });
    }
    const ok = discovery.setLogging(ip, enabled);
    if (!ok) return res.status(404).json({ error: "Controller not found" });
    res.json({ ok: true, ip, loggingEnabled: enabled, firmwareUpdated: false });
  });

  // ── Error handler ─────────────────────────────────────────────────────────
  app.use((err, _req, res, _next) => {
    res.status(500).json({ error: "Internal server error" });
  });

  return { app, storage, loki, discovery, cleanup, tmpDir, serviceEnvPath };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("GET /health", () => {
  let app, tmpDir;

  beforeAll(async () => {
    ({ app, tmpDir } = await buildTestApp());
  });
  afterAll(async () => { await fs.rm(tmpDir, { recursive: true, force: true }); });

  test("returns status ok with 200", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
  });
});

describe("GET /api/v1/health", () => {
  let app, tmpDir;

  beforeAll(async () => {
    ({ app, tmpDir } = await buildTestApp());
  });
  afterAll(async () => { await fs.rm(tmpDir, { recursive: true, force: true }); });

  test("returns status ok with 200", async () => {
    const res = await request(app).get("/api/v1/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
  });
});

describe("GET /api/v1/sources", () => {
  let app, tmpDir, storage;

  beforeAll(async () => {
    ({ app, storage, tmpDir } = await buildTestApp());
  });
  afterAll(async () => { await fs.rm(tmpDir, { recursive: true, force: true }); });

  test("returns empty items array initially", async () => {
    const res = await request(app).get("/api/v1/sources");
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
  });

  test("returns source after appending a record", async () => {
    await storage.append("10.0.0.1", {
      id: "r1", receivedAt: new Date().toISOString(), sourceIp: "10.0.0.1",
      priority: 6, tag: "h", app: "a", message: "msg", raw: "raw",
    });
    const res = await request(app).get("/api/v1/sources");
    expect(res.status).toBe(200);
    expect(res.body.items.some(s => s.ip === "10.0.0.1")).toBe(true);
  });
});

describe("GET /api/v1/logs", () => {
  let app, tmpDir, storage;

  beforeAll(async () => {
    ({ app, storage, tmpDir } = await buildTestApp());
    await storage.append("10.0.0.2", {
      id: "r2", receivedAt: new Date().toISOString(), sourceIp: "10.0.0.2",
      priority: 6, tag: "h", app: "a", message: "hello", raw: "raw",
    });
  });
  afterAll(async () => { await fs.rm(tmpDir, { recursive: true, force: true }); });

  test("returns 400 when ip param is missing", async () => {
    const res = await request(app).get("/api/v1/logs");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/ip/i);
  });

  test("returns empty items for unknown IP", async () => {
    const res = await request(app).get("/api/v1/logs?ip=9.9.9.9");
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
  });

  test("returns records for known IP", async () => {
    const res = await request(app).get("/api/v1/logs?ip=10.0.0.2");
    expect(res.status).toBe(200);
    expect(res.body.items.length).toBe(1);
    expect(res.body.items[0].message).toBe("hello");
  });

  test("respects limit parameter", async () => {
    for (let i = 0; i < 5; i++) {
      await storage.append("10.0.0.3", {
        id: `r${i}`, receivedAt: new Date().toISOString(), sourceIp: "10.0.0.3",
        priority: 6, tag: "h", app: "a", message: `msg${i}`, raw: "r",
      });
    }
    const res = await request(app).get("/api/v1/logs?ip=10.0.0.3&limit=2");
    expect(res.status).toBe(200);
    expect(res.body.items.length).toBe(2);
  });
});

describe("DELETE /api/v1/logs", () => {
  let app, tmpDir, storage;

  beforeEach(async () => {
    ({ app, storage, tmpDir } = await buildTestApp());
  });
  afterEach(async () => { await fs.rm(tmpDir, { recursive: true, force: true }); });

  test("purges a specific IP", async () => {
    await storage.append("10.0.0.5", {
      id: "x", receivedAt: new Date().toISOString(), sourceIp: "10.0.0.5",
      priority: 6, tag: "h", app: "a", message: "m", raw: "r",
    });
    const res = await request(app).delete("/api/v1/logs?ip=10.0.0.5");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.purged).toBe("ip");
  });

  test("purges all when all=true", async () => {
    await storage.append("10.0.0.6", {
      id: "y", receivedAt: new Date().toISOString(), sourceIp: "10.0.0.6",
      priority: 6, tag: "h", app: "a", message: "m", raw: "r",
    });
    const res = await request(app).delete("/api/v1/logs?all=true");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.purged).toBe("all");
  });

  test("returns 400 when neither ip nor all=true provided", async () => {
    const res = await request(app).delete("/api/v1/logs");
    expect(res.status).toBe(400);
  });
});

describe("GET /api/v1/loki/status", () => {
  let app, tmpDir;

  beforeAll(async () => {
    ({ app, tmpDir } = await buildTestApp());
  });
  afterAll(async () => { await fs.rm(tmpDir, { recursive: true, force: true }); });

  test("returns status object", async () => {
    const res = await request(app).get("/api/v1/loki/status");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("state");
  });
});

describe("GET /api/v1/loki/config", () => {
  let app, tmpDir;

  beforeAll(async () => {
    ({ app, tmpDir } = await buildTestApp());
  });
  afterAll(async () => { await fs.rm(tmpDir, { recursive: true, force: true }); });

  test("returns config with url and enabled fields", async () => {
    const res = await request(app).get("/api/v1/loki/config");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("url");
    expect(res.body).toHaveProperty("enabled");
  });
});

describe("PUT /api/v1/loki/config", () => {
  let app, tmpDir;

  beforeEach(async () => {
    ({ app, tmpDir } = await buildTestApp());
  });
  afterEach(async () => { await fs.rm(tmpDir, { recursive: true, force: true }); });

  test("returns ok on valid update", async () => {
    const res = await request(app)
      .put("/api/v1/loki/config")
      .send({ enabled: false, url: "http://localhost:3100" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  test("returns 400 for invalid Loki URL", async () => {
    const res = await request(app)
      .put("/api/v1/loki/config")
      .send({ url: "not-a-valid-url" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/url/i);
  });
});

describe("GET /api/v1/service-config", () => {
  let app, tmpDir;

  beforeAll(async () => {
    ({ app, tmpDir } = await buildTestApp());
  });
  afterAll(async () => { await fs.rm(tmpDir, { recursive: true, force: true }); });

  test("returns schema and values", async () => {
    const res = await request(app).get("/api/v1/service-config");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.schema)).toBe(true);
    expect(typeof res.body.values).toBe("object");
  });
});

describe("POST /api/v1/service-config", () => {
  let app, tmpDir, serviceEnvPath;

  beforeEach(async () => {
    ({ app, tmpDir, serviceEnvPath } = await buildTestApp());
  });
  afterEach(async () => { await fs.rm(tmpDir, { recursive: true, force: true }); });

  test("writes values and returns restartRequired", async () => {
    const res = await request(app)
      .post("/api/v1/service-config")
      .send({ values: { LLS_HTTP_PORT: "9090" } });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.restartRequired).toBe(true);
    // Verify written to disk
    const values = await readServiceEnv(serviceEnvPath);
    expect(values.LLS_HTTP_PORT).toBe("9090");
  });
});

describe("GET /api/v1/controllers", () => {
  let app, tmpDir;

  beforeAll(async () => {
    ({ app, tmpDir } = await buildTestApp());
  });
  afterAll(async () => { await fs.rm(tmpDir, { recursive: true, force: true }); });

  test("returns items array", async () => {
    const res = await request(app).get("/api/v1/controllers");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
  });
});

describe("PATCH /api/v1/controllers/:ip/logging", () => {
  let app, tmpDir, discovery;

  beforeEach(async () => {
    ({ app, tmpDir, discovery } = await buildTestApp());
  });
  afterEach(async () => { await fs.rm(tmpDir, { recursive: true, force: true }); });

  test("returns 400 when enabled is not boolean", async () => {
    const res = await request(app)
      .patch("/api/v1/controllers/10.0.0.1/logging")
      .send({ enabled: "yes" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/boolean/i);
  });

  test("returns 404 when controller not found", async () => {
    const res = await request(app)
      .patch("/api/v1/controllers/9.9.9.9/logging")
      .send({ enabled: true });
    expect(res.status).toBe(404);
  });

  test("updates logging flag for known controller", async () => {
    discovery.controllers.set("10.0.0.5", {
      ip: "10.0.0.5", name: "test", loggingEnabled: true,
    });
    const res = await request(app)
      .patch("/api/v1/controllers/10.0.0.5/logging")
      .send({ enabled: false });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.loggingEnabled).toBe(false);
  });
});
