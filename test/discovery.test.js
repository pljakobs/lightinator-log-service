"use strict";

const os = require("os");
const path = require("path");
const fs = require("fs/promises");
const { ControllerDiscovery } = require("../src/discovery");

describe("ControllerDiscovery — in-memory logic", () => {
  let discovery;

  beforeEach(() => {
    discovery = new ControllerDiscovery({
      seedHosts: ["10.0.0.1"],
      controllerPort: 80,
      refreshIntervalMs: 0, // no timer
    });
  });

  afterEach(() => {
    discovery.stop();
  });

  // ── isLoggingEnabled ──────────────────────────────────────────────────────

  test("isLoggingEnabled returns true for unknown IP (safe default)", () => {
    expect(discovery.isLoggingEnabled("1.2.3.4")).toBe(true);
  });

  test("isLoggingEnabled returns true when loggingEnabled is true", () => {
    discovery.controllers.set("1.2.3.4", { loggingEnabled: true });
    expect(discovery.isLoggingEnabled("1.2.3.4")).toBe(true);
  });

  test("isLoggingEnabled returns false only when explicitly false", () => {
    discovery.controllers.set("1.2.3.4", { loggingEnabled: false });
    expect(discovery.isLoggingEnabled("1.2.3.4")).toBe(false);
  });

  test("isLoggingEnabled returns true when loggingEnabled is undefined", () => {
    discovery.controllers.set("1.2.3.4", {});
    expect(discovery.isLoggingEnabled("1.2.3.4")).toBe(true);
  });

  // ── setLogging ─────────────────────────────────────────────────────────────

  test("setLogging returns false for unknown IP", () => {
    expect(discovery.setLogging("9.9.9.9", true)).toBe(false);
  });

  test("setLogging returns true and updates flag for known IP", () => {
    discovery.controllers.set("1.2.3.4", { loggingEnabled: true });
    const result = discovery.setLogging("1.2.3.4", false);
    expect(result).toBe(true);
    expect(discovery.controllers.get("1.2.3.4").loggingEnabled).toBe(false);
  });

  test("setLogging coerces truthy value to boolean true", () => {
    discovery.controllers.set("1.2.3.4", { loggingEnabled: false });
    discovery.setLogging("1.2.3.4", 1);
    expect(discovery.controllers.get("1.2.3.4").loggingEnabled).toBe(true);
  });

  test("setLogging coerces falsy value to boolean false", () => {
    discovery.controllers.set("1.2.3.4", { loggingEnabled: true });
    discovery.setLogging("1.2.3.4", 0);
    expect(discovery.controllers.get("1.2.3.4").loggingEnabled).toBe(false);
  });

  // ── getGroupsForIp ─────────────────────────────────────────────────────────

  test("getGroupsForIp returns empty array for unknown IP", () => {
    expect(discovery.getGroupsForIp("9.9.9.9")).toEqual([]);
  });

  test("getGroupsForIp returns groups for known controller", () => {
    const groups = [{ id: "g1", name: "living" }];
    discovery.controllers.set("1.2.3.4", { groups });
    expect(discovery.getGroupsForIp("1.2.3.4")).toEqual(groups);
  });

  // ── getAll ─────────────────────────────────────────────────────────────────

  test("getAll returns empty array when no controllers", () => {
    expect(discovery.getAll()).toEqual([]);
  });

  test("getAll returns all controller values", () => {
    const c1 = { ip: "1.2.3.4", name: "A" };
    const c2 = { ip: "1.2.3.5", name: "B" };
    discovery.controllers.set("1.2.3.4", c1);
    discovery.controllers.set("1.2.3.5", c2);
    const all = discovery.getAll();
    expect(all.length).toBe(2);
    expect(all).toContainEqual(c1);
    expect(all).toContainEqual(c2);
  });

  // ── addSeenIp ─────────────────────────────────────────────────────────────

  test("addSeenIp adds IP to extraSeeds if not already in controllers", () => {
    discovery.addSeenIp("5.5.5.5");
    expect(discovery.extraSeeds.has("5.5.5.5")).toBe(true);
  });

  test("addSeenIp does not add IP already tracked in controllers", () => {
    discovery.controllers.set("5.5.5.5", { ip: "5.5.5.5" });
    discovery.addSeenIp("5.5.5.5");
    expect(discovery.extraSeeds.has("5.5.5.5")).toBe(false);
  });

  test("addSeenIp does not add IP that is already an extraSeed", () => {
    discovery.extraSeeds.add("5.5.5.5");
    const sizeBefore = discovery.extraSeeds.size;
    discovery.addSeenIp("5.5.5.5");
    expect(discovery.extraSeeds.size).toBe(sizeBefore);
  });
});

describe("ControllerDiscovery — state persistence", () => {
  let tmpDir;
  let statePath;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "lls-discovery-"));
    statePath = path.join(tmpDir, "controllers.json");
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test("_loadState is a no-op when statePath is null", async () => {
    const d = new ControllerDiscovery({ seedHosts: [], refreshIntervalMs: 0, statePath: null });
    await expect(d._loadState()).resolves.not.toThrow();
    d.stop();
  });

  test("_loadState does not throw when state file does not exist", async () => {
    const d = new ControllerDiscovery({ seedHosts: [], refreshIntervalMs: 0, statePath });
    await expect(d._loadState()).resolves.not.toThrow();
    d.stop();
  });

  test("_loadState populates controllers as offline from persisted data", async () => {
    const entries = [
      { ip: "10.0.0.1", name: "A", loggingEnabled: true, reachable: true },
    ];
    await fs.writeFile(statePath, JSON.stringify(entries), "utf8");
    const d = new ControllerDiscovery({ seedHosts: [], refreshIntervalMs: 0, statePath });
    await d._loadState();
    const c = d.controllers.get("10.0.0.1");
    expect(c).toBeDefined();
    expect(c.reachable).toBe(false); // marked offline until confirmed
    d.stop();
  });

  test("_saveState persists current controllers to disk", async () => {
    const d = new ControllerDiscovery({ seedHosts: [], refreshIntervalMs: 0, statePath });
    d.controllers.set("10.0.0.2", { ip: "10.0.0.2", name: "B", loggingEnabled: false });
    await d._saveState();
    const raw = await fs.readFile(statePath, "utf8");
    const parsed = JSON.parse(raw);
    expect(parsed.some(e => e.ip === "10.0.0.2")).toBe(true);
    d.stop();
  });

  test("_saveState is a no-op when statePath is null", async () => {
    const d = new ControllerDiscovery({ seedHosts: [], refreshIntervalMs: 0, statePath: null });
    await expect(d._saveState()).resolves.not.toThrow();
    d.stop();
  });
});

describe("ControllerDiscovery — start / stop", () => {
  test("stop() clears timer without throwing", () => {
    const d = new ControllerDiscovery({ seedHosts: [], refreshIntervalMs: 999999 });
    // Don't call start() to avoid network calls; manually set timer
    d._timer = setInterval(() => {}, 999999);
    expect(() => d.stop()).not.toThrow();
    expect(d._timer).toBeNull();
  });
});
