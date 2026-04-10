"use strict";

/**
 * Tests for config.js — specifically the envInt helper and the exported
 * config object defaults.  We reload the module after manipulating env vars
 * so each test gets a fresh evaluation.
 */

describe("envInt helper (via config module)", () => {
  const ORIG = { ...process.env };

  afterEach(() => {
    // Restore env after each test and purge the cached module
    for (const k of Object.keys(process.env)) {
      if (!(k in ORIG)) delete process.env[k];
    }
    Object.assign(process.env, ORIG);
    jest.resetModules();
  });

  test("uses fallback when env var is absent", () => {
    delete process.env.LLS_HTTP_PORT;
    const { config } = require("../src/config");
    expect(config.httpPort).toBe(4821);
  });

  test("parses valid integer from env var", () => {
    process.env.LLS_HTTP_PORT = "9999";
    const { config } = require("../src/config");
    expect(config.httpPort).toBe(9999);
  });

  test("uses fallback when env var is not a valid number", () => {
    process.env.LLS_HTTP_PORT = "notanumber";
    const { config } = require("../src/config");
    expect(config.httpPort).toBe(4821);
  });

  test("uses fallback when env var is empty string", () => {
    process.env.LLS_HTTP_PORT = "";
    const { config } = require("../src/config");
    expect(config.httpPort).toBe(4821);
  });

  test("parses LLS_UDP_PORT", () => {
    process.env.LLS_UDP_PORT = "1234";
    const { config } = require("../src/config");
    expect(config.udpPort).toBe(1234);
  });

  test("parses LLS_MAX_BYTES_PER_IP", () => {
    process.env.LLS_MAX_BYTES_PER_IP = "1048576";
    const { config } = require("../src/config");
    expect(config.maxBytesPerIp).toBe(1048576);
  });

  test("parses LLS_RETENTION_DAYS", () => {
    process.env.LLS_RETENTION_DAYS = "14";
    const { config } = require("../src/config");
    expect(config.retentionDays).toBe(14);
  });
});

describe("config defaults", () => {
  beforeEach(() => {
    // Remove all LLS_ vars so we get clean defaults
    for (const k of Object.keys(process.env)) {
      if (k.startsWith("LLS_")) delete process.env[k];
    }
    jest.resetModules();
  });

  afterEach(() => {
    jest.resetModules();
  });

  test("host defaults to 0.0.0.0", () => {
    const { config } = require("../src/config");
    expect(config.host).toBe("0.0.0.0");
  });

  test("udpHost defaults to 0.0.0.0", () => {
    const { config } = require("../src/config");
    expect(config.udpHost).toBe("0.0.0.0");
  });

  test("corsOrigin defaults to *", () => {
    const { config } = require("../src/config");
    expect(config.corsOrigin).toBe("*");
  });

  test("serviceName defaults to LightinatorLogService", () => {
    const { config } = require("../src/config");
    expect(config.serviceName).toBe("LightinatorLogService");
  });

  test("mdnsHost defaults to lightinator-logservice.local", () => {
    const { config } = require("../src/config");
    expect(config.mdnsHost).toBe("lightinator-logservice.local");
  });

  test("discoverySeedHosts defaults to ['lightinator.local']", () => {
    const { config } = require("../src/config");
    expect(config.discoverySeedHosts).toEqual(["lightinator.local"]);
  });

  test("syslogAdvertiseHost defaults to empty string", () => {
    const { config } = require("../src/config");
    expect(config.syslogAdvertiseHost).toBe("");
  });
});

describe("config string overrides", () => {
  const ORIG = { ...process.env };

  afterEach(() => {
    for (const k of Object.keys(process.env)) {
      if (!(k in ORIG)) delete process.env[k];
    }
    Object.assign(process.env, ORIG);
    jest.resetModules();
  });

  test("LLS_HTTP_HOST overrides host", () => {
    process.env.LLS_HTTP_HOST = "127.0.0.1";
    const { config } = require("../src/config");
    expect(config.host).toBe("127.0.0.1");
  });

  test("LLS_CORS_ORIGIN overrides corsOrigin", () => {
    process.env.LLS_CORS_ORIGIN = "https://example.com";
    const { config } = require("../src/config");
    expect(config.corsOrigin).toBe("https://example.com");
  });

  test("LLS_DISCOVERY_SEEDS splits on comma", () => {
    process.env.LLS_DISCOVERY_SEEDS = "10.0.0.1,10.0.0.2, 10.0.0.3 ";
    const { config } = require("../src/config");
    expect(config.discoverySeedHosts).toEqual(["10.0.0.1", "10.0.0.2", "10.0.0.3"]);
  });

  test("LLS_DISCOVERY_SEEDS filters empty entries", () => {
    process.env.LLS_DISCOVERY_SEEDS = "10.0.0.1,,10.0.0.2";
    const { config } = require("../src/config");
    expect(config.discoverySeedHosts).toEqual(["10.0.0.1", "10.0.0.2"]);
  });

  test("LLS_SYSLOG_ADVERTISE_HOST overrides syslogAdvertiseHost", () => {
    process.env.LLS_SYSLOG_ADVERTISE_HOST = "192.168.1.5";
    const { config } = require("../src/config");
    expect(config.syslogAdvertiseHost).toBe("192.168.1.5");
  });
});
