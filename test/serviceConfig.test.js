"use strict";

const os = require("os");
const path = require("path");
const fs = require("fs/promises");
const { SETTINGS_SCHEMA, readServiceEnv, writeServiceEnv } = require("../src/serviceConfig");

describe("SETTINGS_SCHEMA", () => {
  test("is a non-empty array", () => {
    expect(Array.isArray(SETTINGS_SCHEMA)).toBe(true);
    expect(SETTINGS_SCHEMA.length).toBeGreaterThan(0);
  });

  test("each entry has key, label, description, type", () => {
    for (const s of SETTINGS_SCHEMA) {
      expect(typeof s.key).toBe("string");
      expect(typeof s.label).toBe("string");
      expect(typeof s.description).toBe("string");
      expect(["text", "number"]).toContain(s.type);
    }
  });

  test("contains well-known keys", () => {
    const keys = SETTINGS_SCHEMA.map(s => s.key);
    expect(keys).toContain("LLS_UDP_PORT");
    expect(keys).toContain("LLS_HTTP_PORT");
    expect(keys).toContain("LLS_DISCOVERY_SEEDS");
  });
});

describe("readServiceEnv", () => {
  let tmpDir;
  let envPath;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "lls-test-"));
    envPath = path.join(tmpDir, "service.env");
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test("returns empty object when file does not exist", async () => {
    const values = await readServiceEnv(envPath);
    expect(values).toEqual({});
  });

  test("parses simple KEY=VALUE pairs", async () => {
    await fs.writeFile(envPath, "LLS_HTTP_PORT=9000\nLLS_UDP_PORT=5515\n", "utf8");
    const values = await readServiceEnv(envPath);
    expect(values).toEqual({ LLS_HTTP_PORT: "9000", LLS_UDP_PORT: "5515" });
  });

  test("ignores comment lines", async () => {
    await fs.writeFile(envPath, "# this is a comment\nLLS_HTTP_PORT=4821\n", "utf8");
    const values = await readServiceEnv(envPath);
    expect(values).toHaveProperty("LLS_HTTP_PORT", "4821");
    expect(Object.keys(values)).not.toContain("# this is a comment");
  });

  test("ignores blank lines", async () => {
    await fs.writeFile(envPath, "\n\nLLS_HTTP_PORT=4821\n\n", "utf8");
    const values = await readServiceEnv(envPath);
    expect(values).toEqual({ LLS_HTTP_PORT: "4821" });
  });

  test("ignores lines without '='", () => {
    return fs.writeFile(envPath, "BADLINE\nLLS_UDP_PORT=5514\n", "utf8")
      .then(() => readServiceEnv(envPath))
      .then((values) => {
        expect(values).not.toHaveProperty("BADLINE");
        expect(values).toHaveProperty("LLS_UDP_PORT", "5514");
      });
  });

  test("ignores lines where '=' is the first char (empty key)", async () => {
    await fs.writeFile(envPath, "=VALUE\nLLS_UDP_PORT=5514\n", "utf8");
    const values = await readServiceEnv(envPath);
    expect(values).not.toHaveProperty("");
    expect(values).toHaveProperty("LLS_UDP_PORT", "5514");
  });

  test("value may contain '=' characters", async () => {
    await fs.writeFile(envPath, "LLS_THING=a=b=c\n", "utf8");
    const values = await readServiceEnv(envPath);
    expect(values.LLS_THING).toBe("a=b=c");
  });

  test("trims whitespace from keys and values", async () => {
    await fs.writeFile(envPath, "  LLS_HTTP_PORT  =  4821  \n", "utf8");
    const values = await readServiceEnv(envPath);
    expect(values).toHaveProperty("LLS_HTTP_PORT", "4821");
  });
});

describe("writeServiceEnv", () => {
  let tmpDir;
  let envPath;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "lls-test-"));
    envPath = path.join(tmpDir, "subdir", "service.env");
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test("creates parent directories if necessary", async () => {
    await writeServiceEnv(envPath, {});
    const stat = await fs.stat(envPath);
    expect(stat.isFile()).toBe(true);
  });

  test("written file can be read back by readServiceEnv", async () => {
    const input = { LLS_HTTP_PORT: "9090", LLS_UDP_PORT: "5515" };
    await writeServiceEnv(envPath, input);
    const values = await readServiceEnv(envPath);
    expect(values.LLS_HTTP_PORT).toBe("9090");
    expect(values.LLS_UDP_PORT).toBe("5515");
  });

  test("entries with empty string are written as commented-out", async () => {
    await writeServiceEnv(envPath, { LLS_HTTP_PORT: "" });
    const raw = await fs.readFile(envPath, "utf8");
    expect(raw).toContain("#LLS_HTTP_PORT=");
  });

  test("undefined values are written as commented-out", async () => {
    await writeServiceEnv(envPath, {});
    const raw = await fs.readFile(envPath, "utf8");
    // All schema keys should appear as commented lines
    for (const s of SETTINGS_SCHEMA) {
      expect(raw).toContain(`#${s.key}=`);
    }
  });

  test("active values are not commented out", async () => {
    await writeServiceEnv(envPath, { LLS_UDP_PORT: "1234" });
    const raw = await fs.readFile(envPath, "utf8");
    expect(raw).toContain("LLS_UDP_PORT=1234");
    // Must NOT be commented — check there's a plain line (not prefixed with #)
    const lines = raw.split("\n");
    const activeLine = lines.find(l => l === "LLS_UDP_PORT=1234");
    expect(activeLine).toBeDefined();
  });

  test("written file starts with a header comment", async () => {
    await writeServiceEnv(envPath, {});
    const raw = await fs.readFile(envPath, "utf8");
    expect(raw.startsWith("#")).toBe(true);
  });
});
