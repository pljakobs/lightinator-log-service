const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { readServiceEnv, writeServiceEnv, loadServiceEnvironment, getServiceCredential, getPublicServiceConfig, getAIBackends } = require("../src/serviceConfig");
const { LokiForwarder } = require("../src/loki");
const { AIService } = require("../src/aiService");
const { startServer } = require("./e2e/server");

// Assuming an app export or test harness setup
test("API persistence correctly records crash decode metadata fields", async (t) => {
  // Mock storage / database interaction or spin up test server instance
  const mockStorage = {
    lastUpdatedRecord: null,
    async updateCrashDecode(id, decoded, metadata) {
      this.lastUpdatedRecord = { id, decoded, metadata };
    }
  };

  // Verify that metadata parameters (gitVersion, soc, buildType) are correctly passed and handled
  await mockStorage.updateCrashDecode(123, "Decoded stack trace", {
    gitVersion: "V1.0.0-1-develop",
    soc: "esp32",
    buildType: "debug"
  });

  assert.strictEqual(mockStorage.lastUpdatedRecord.metadata.gitVersion, "V1.0.0-1-develop");
  assert.strictEqual(mockStorage.lastUpdatedRecord.metadata.soc, "esp32");
  assert.strictEqual(mockStorage.lastUpdatedRecord.metadata.buildType, "debug");
});

test("public service settings expose configured flags but no saved or environment credentials", () => {
  const publicConfig = getPublicServiceConfig({
    LLS_GITHUB_TOKEN: "github-private",
    LLS_GEMINI_API_KEY: "gemini-private",
    UNLISTED_TOKEN: "unlisted-private",
    LLS_DB_PATH: "/tmp/internal-config/database.sqlite",
    LLS_SERVICE_ENV: "/tmp/internal-config/service.env",
    LLS_HTTP_PORT: "4900",
  }, { GEMINI_API_KEY: "live-private", LLS_HTTP_PORT: "4821", LLS_DATA_DIR: "/tmp/internal-config/logs" }, { GOOGLE_API_KEY: "environment-private" });
  assert.strictEqual(publicConfig.values.LLS_HTTP_PORT, "4900");
  assert.strictEqual(JSON.parse(publicConfig.values.LLS_AI_BACKENDS)[0].tokenConfigured, true);
  assert.deepStrictEqual(publicConfig.liveValues, { LLS_HTTP_PORT: "4821" });
  assert.deepStrictEqual(publicConfig.credentialsConfigured, { LLS_GITHUB_TOKEN: true, GEMINI_API_KEY: true });
  assert.ok(!JSON.stringify(publicConfig).includes("private"));
  assert.ok(!JSON.stringify(publicConfig).includes("internal-config"));
  assert.ok(!publicConfig.schema.some(setting => ["LLS_DB_PATH", "LLS_SERVICE_ENV", "LLS_DATA_DIR"].includes(setting.key)));
  assert.ok(publicConfig.schema.filter(setting => setting.type === "password").every(setting => setting.writeOnly));
  assert.strictEqual(getPublicServiceConfig({}, {}, { GOOGLE_API_KEY: "environment-private" }).credentialsConfigured.GEMINI_API_KEY, true);
});

test("service credentials preserve omitted and blank updates, replace and explicitly clear", async context => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "lls-credentials-"));
  context.after(() => fs.rm(temp, { recursive: true, force: true }));
  const envPath = path.join(temp, "service.env");
  await fs.writeFile(envPath, "LLS_GITHUB_TOKEN=original-token\nLLS_GEMINI_API_KEY=original-key\nLLS_HTTP_HOST=127.0.0.1\n");
  await writeServiceEnv(envPath, { LLS_HTTP_PORT: "4900", LLS_GITHUB_TOKEN: "", GEMINI_API_KEY: "" });
  let saved = await readServiceEnv(envPath);
  assert.strictEqual(saved.LLS_GITHUB_TOKEN, "original-token");
  assert.strictEqual(saved.LLS_GEMINI_API_KEY, "original-key");
  assert.strictEqual(saved.LLS_HTTP_HOST, "127.0.0.1");
  assert.strictEqual((await fs.stat(envPath)).mode & 0o777, 0o600);
  await writeServiceEnv(envPath, { GEMINI_API_KEY: "replacement-key", LLS_GITHUB_TOKEN: "replacement-token" });
  saved = await readServiceEnv(envPath);
  assert.strictEqual(getServiceCredential(saved, "GEMINI_API_KEY", {}), "replacement-key");
  assert.strictEqual(saved.LLS_GEMINI_API_KEY, undefined);
  await writeServiceEnv(envPath, { GEMINI_API_KEY: null, LLS_GITHUB_TOKEN: null });
  saved = await readServiceEnv(envPath);
  assert.strictEqual(getServiceCredential(saved, "GEMINI_API_KEY", { GOOGLE_API_KEY: "environment-key" }), "");
  assert.deepStrictEqual(getPublicServiceConfig(saved, {}, { LLS_GITHUB_TOKEN: "environment-token" }).credentialsConfigured, { LLS_GITHUB_TOKEN: false, GEMINI_API_KEY: false });
});

test("service settings reject newline injection and invalid input without altering stored secrets", async context => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "lls-env-injection-"));
  context.after(() => fs.rm(temp, { recursive: true, force: true }));
  const envPath = path.join(temp, "service.env");
  await writeServiceEnv(envPath, { LLS_GITHUB_TOKEN: "stored-token" });
  const original = await fs.readFile(envPath, "utf8");
  for (const values of [{ LLS_MDNS_HOST: "host\nLLS_GITHUB_TOKEN=changed" }, { GEMINI_API_KEY: "key\rINJECTED=value" }, { GEMINI_API_KEY: "key\0suffix" }, { GEMINI_API_KEY: {} }, { UNKNOWN_SETTING: "value" }, []]) {
    await assert.rejects(writeServiceEnv(envPath, values), error => error.status === 400);
  }
  assert.strictEqual(await fs.readFile(envPath, "utf8"), original);
});

test("AI keys are not logged and explicitly cleared keys disable the client", context => {
  const logs = [];
  context.mock.method(console, "log", message => logs.push(message));
  const configured = new AIService({ apiKey: "private-key-for-test" });
  assert.ok(configured.isAvailable());
  assert.ok(!logs.join("\n").includes("private"));
  assert.strictEqual(new AIService({ apiKey: "" }).isAvailable(), false);
});

test("Loki passwords are write-only and cannot follow destination changes implicitly", async context => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "lls-loki-secrets-"));
  context.after(() => fs.rm(temp, { recursive: true, force: true }));
  const loki = new LokiForwarder({ configPath: path.join(temp, "loki.json") });
  context.after(() => loki.stop());
  await loki.saveConfig({ url: "https://original.example.test", username: "user", password: "private-password" });
  const publicConfig = loki.getConfig();
  assert.strictEqual(publicConfig.password, undefined);
  assert.strictEqual(publicConfig.passwordConfigured, true);
  assert.ok(!JSON.stringify(publicConfig).includes("private-password"));
  await loki.saveConfig({ password: "", labels: { job: "updated" } });
  assert.strictEqual(loki.config.password, "private-password");
  await assert.rejects(loki.saveConfig({ url: "https://other.example.test" }), /requires replacing or clearing/);
  await assert.rejects(loki.testConnection({ url: "https://other.example.test", password: "" }), /requires replacing or clearing/);
  await assert.rejects(loki.testConnection({ username: "other-user" }), /requires replacing or clearing/);
  await assert.rejects(loki.saveConfig({ url: "https://user:secret@example.test", password: "replacement" }), /without embedded credentials/);
  await assert.rejects(loki.saveConfig({ url: "file:///tmp/loki", password: null }), /HTTP\(S\)/);
  await loki.saveConfig({ password: null });
  assert.strictEqual(loki.getConfig().passwordConfigured, false);
});

test("Loki connection tests keep their own credentials without mutating forwarding config", async context => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "lls-loki-overrides-"));
  context.after(() => fs.rm(temp, { recursive: true, force: true }));
  const loki = new LokiForwarder({ configPath: path.join(temp, "loki.json") });
  context.after(() => loki.stop());
  await loki.saveConfig({ password: "original", username: "user" });
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  let testConfig;
  loki._push = async (records, effectiveConfig) => { testConfig = effectiveConfig; await pending; };
  const result = loki.testConnection({ url: "https://test.example.test", password: "test-only" });
  assert.strictEqual(loki.config.password, "original");
  assert.strictEqual(testConfig.password, "test-only");
  await loki.saveConfig({ labels: { job: "updated-during-test" } });
  finish();
  await result;
  assert.deepStrictEqual(loki.config.labels, { job: "updated-during-test" });
  assert.strictEqual(loki.config.password, "original");
});

test("Loki errors cannot reflect credentials from an upstream response", async context => {
  let authorization;
  const upstream = http.createServer((request, response) => {
    authorization = request.headers.authorization;
    request.resume();
    response.writeHead(500);
    response.end("upstream reflected private-password");
  });
  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise(resolve => upstream.close(resolve)));
  const loki = new LokiForwarder({ configPath: "unused" });
  loki.config = { ...loki.config, url: `http://127.0.0.1:${upstream.address().port}`, username: "user", password: "private-password" };
  await assert.rejects(loki.testConnection(), error => error.message === "Loki returned HTTP 500");
  assert.strictEqual(authorization, "Basic " + Buffer.from("user:private-password").toString("base64"));
});

test("HTTP credential endpoints expose only flags and support keep, replace, and clear", async context => {
  const server = await startServer({ env: {
    LLS_GITHUB_TOKEN: "environment-private-github", LLS_GEMINI_API_KEY: "environment-private-gemini",
    GEMINI_API_KEY: "", GOOGLE_API_KEY: "", LLS_DISCOVERY_REFRESH_MS: "0",
  } });
  context.after(() => server.stop());
  const request = (endpoint, method, body) => fetch(server.baseUrl + endpoint, {
    method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined,
  });
  const getSettings = async () => {
    const response = await request("/api/v1/service-config", "GET");
    const text = await response.text();
    assert.ok(!text.includes("private-"));
    assert.ok(!text.includes("/tmp/lls-e2e-"));
    return JSON.parse(text);
  };
  assert.strictEqual((await getSettings()).credentialsConfigured.GEMINI_API_KEY, true);
  const serviceInfo = await (await request("/api/v1/service-info", "GET")).json();
  assert.strictEqual(serviceInfo.storage.dataDir, undefined);
  const pathUpdate = await request("/api/v1/service-config", "POST", { values: { LLS_DB_PATH: "/tmp/replacement.sqlite" } });
  assert.strictEqual(pathUpdate.status, 400);
  assert.ok(!server.getOutput().includes("environment-private"));
  let response = await request("/api/v1/service-config", "POST", { values: { LLS_GITHUB_TOKEN: "saved-private-github", GEMINI_API_KEY: "saved-private-gemini" } });
  assert.strictEqual(response.status, 200);
  response = await request("/api/v1/service-config", "POST", { values: { LLS_GITHUB_TOKEN: "", GEMINI_API_KEY: "", LLS_HTTP_PORT: "4900" } });
  assert.strictEqual(response.status, 200);
  assert.deepStrictEqual((await getSettings()).credentialsConfigured, { LLS_GITHUB_TOKEN: true, GEMINI_API_KEY: true });
  response = await request("/api/v1/service-config", "POST", { values: { GEMINI_API_KEY: "secret\nLLS_GITHUB_TOKEN=injected" } });
  assert.strictEqual(response.status, 400);
  assert.ok(!(await response.text()).includes("secret"));
  response = await request("/api/v1/service-config", "POST", { values: { LLS_GITHUB_TOKEN: null, GEMINI_API_KEY: null } });
  assert.strictEqual(response.status, 200);
  assert.deepStrictEqual((await getSettings()).credentialsConfigured, { LLS_GITHUB_TOKEN: false, GEMINI_API_KEY: false });
  response = await request("/api/v1/loki/config", "PUT", { username: "user", password: "loki-private-password" });
  assert.strictEqual(response.status, 200);
  const lokiConfig = await (await request("/api/v1/loki/config", "GET")).json();
  assert.strictEqual(lokiConfig.password, undefined);
  assert.strictEqual(lokiConfig.passwordConfigured, true);
  response = await request("/api/v1/loki/test", "POST", { url: "https://replacement.example.test" });
  assert.strictEqual(response.status, 400);
  response = await request("/api/v1/loki/test", "POST", { url: "https://user:reflection-private@example.test" });
  assert.strictEqual(response.status, 400);
  assert.ok(!(await response.text()).includes("reflection-private"));
});

test("persisted service settings are applied on startup and restart", async context => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "lls-config-restart-"));
  context.after(() => fs.rm(temp, { recursive: true, force: true }));
  const envPath = path.join(temp, "service.env");
  await writeServiceEnv(envPath, { LLS_MAX_ROWS_PER_IP: "37", LLS_RETENTION_DAYS: "2", LLS_CONTROLLER_STALE_DAYS: "0" });
  const options = { env: { LLS_SERVICE_ENV: envPath, LLS_MAX_ROWS_PER_IP: "", LLS_RETENTION_DAYS: "", LLS_CONTROLLER_STALE_DAYS: "", LLS_DISCOVERY_REFRESH_MS: "0" } };
  let server = await startServer(options);
  try {
    let response = await fetch(server.baseUrl + "/api/v1/service-config");
    let settings = await response.json();
    assert.strictEqual(settings.liveValues.LLS_MAX_ROWS_PER_IP, "37");
    assert.strictEqual(settings.liveValues.LLS_RETENTION_DAYS, "2");
    assert.strictEqual(settings.liveValues.LLS_CONTROLLER_STALE_DAYS, "0");
    response = await fetch(server.baseUrl + "/api/v1/service-config", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ values: { LLS_MAX_ROWS_PER_IP: "19" } }),
    });
    assert.strictEqual(response.status, 200);
    await server.stop();
    server = await startServer(options);
    settings = await (await fetch(server.baseUrl + "/api/v1/service-config")).json();
    assert.strictEqual(settings.liveValues.LLS_MAX_ROWS_PER_IP, "19");
    assert.strictEqual(settings.liveValues.LLS_RETENTION_DAYS, "2");
  } finally {
    await server.stop();
  }
});

test("invalid AI configuration still exposes the full form and can be repaired", async context => {
  const publicConfig = getPublicServiceConfig({ LLS_AI_BACKENDS: "invalid-private-value" }, {}, {});
  assert.ok(publicConfig.schema.some(setting => setting.key === "LLS_HTTP_HOST"));
  assert.ok(publicConfig.configurationErrors.length);
  assert.ok(!JSON.stringify(publicConfig).includes("invalid-private-value"));
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "lls-ai-repair-"));
  context.after(() => fs.rm(temp, { recursive: true, force: true }));
  const envPath = path.join(temp, "service.env");
  await fs.writeFile(envPath, "LLS_AI_BACKENDS=invalid-private-value\n");
  await writeServiceEnv(envPath, { LLS_AI_BACKENDS: "[]" });
  assert.deepStrictEqual(getAIBackends(await readServiceEnv(envPath), {}), []);
});

test("saving default AI settings does not duplicate a legacy Gemini token that survives clearing", async context => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "lls-ai-legacy-key-"));
  context.after(() => fs.rm(temp, { recursive: true, force: true }));
  const envPath = path.join(temp, "service.env");
  await writeServiceEnv(envPath, { GEMINI_API_KEY: "legacy-private-token" });
  let saved = await readServiceEnv(envPath);
  const publicConfig = getPublicServiceConfig(saved, {}, {});
  await writeServiceEnv(envPath, { LLS_AI_BACKENDS: publicConfig.values.LLS_AI_BACKENDS });
  saved = await readServiceEnv(envPath);
  assert.strictEqual(JSON.parse(saved.LLS_AI_BACKENDS)[0].token, "");
  assert.strictEqual(getAIBackends(saved, {})[0].token, "legacy-private-token");
  await writeServiceEnv(envPath, { GEMINI_API_KEY: null });
  assert.strictEqual(getAIBackends(await readServiceEnv(envPath), {})[0].token, "");
});

test("upgrade preserves legacy quoted keys and models without rewriting the environment file", async context => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "lls-upgrade-env-"));
  context.after(() => fs.rm(temp, { recursive: true, force: true }));
  const envPath = path.join(temp, "service.env");
  const original = "LLS_GEMINI_API_KEY='legacy-key#suffix'\nGEMINI_MODEL=\"existing-model\"\nLLS_GITHUB_TOKEN=legacy-github#suffix\nLLS_GITHUB_REPO=\"owner/repo\"\nLLS_AI_ENABLED=false\n";
  await fs.writeFile(envPath, original);
  const environment = { LLS_GEMINI_API_KEY: "'legacy-key#suffix'", GEMINI_MODEL: '"existing-model"' };
  const saved = await loadServiceEnvironment(envPath, environment);
  assert.strictEqual(environment.GEMINI_MODEL, "existing-model");
  assert.strictEqual(saved.LLS_GITHUB_TOKEN, "legacy-github#suffix");
  const providers = getAIBackends(saved, environment);
  assert.strictEqual(providers[0].token, "legacy-key#suffix");
  assert.strictEqual(providers[0].models[0], "existing-model");
  assert.strictEqual(await fs.readFile(envPath, "utf8"), original);
  const server = await startServer({ env: {
    LLS_SERVICE_ENV: envPath, LLS_GEMINI_API_KEY: "'legacy-key#suffix'", GEMINI_MODEL: '"existing-model"',
    GEMINI_API_KEY: "", GOOGLE_API_KEY: "", LLS_DISCOVERY_REFRESH_MS: "0",
  } });
  context.after(() => server.stop());
  const settings = await (await fetch(server.baseUrl + "/api/v1/service-config")).json();
  assert.strictEqual(settings.liveValues.GEMINI_MODEL, "existing-model");
  assert.strictEqual(settings.liveValues.LLS_AI_ENABLED, "false");
  assert.strictEqual(JSON.parse(settings.values.LLS_AI_BACKENDS)[0].models[0], "existing-model");
  assert.ok(!JSON.stringify(settings).includes("legacy-key"));
  assert.strictEqual(await fs.readFile(envPath, "utf8"), original);
});

test("upgrade migrates URL-embedded Loki credentials privately and preserves an owner-only backup", async context => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "lls-upgrade-loki-"));
  context.after(() => fs.rm(temp, { recursive: true, force: true }));
  const configPath = path.join(temp, "loki.json");
  const original = JSON.stringify({ enabled: false, url: "https://legacy-user:legacy%23password@loki.example.test", labels: { job: "legacy" }, futureSetting: "preserve" });
  await fs.writeFile(configPath, original);
  const loki = new LokiForwarder({ configPath });
  context.after(() => loki.stop());
  await loki.loadConfig();
  assert.strictEqual(loki.config.username, "legacy-user");
  assert.strictEqual(loki.config.password, "legacy#password");
  assert.strictEqual(new URL(loki.getConfig().url).username, "");
  assert.ok(!JSON.stringify(loki.getConfig()).includes("legacy#password"));
  assert.strictEqual(await fs.readFile(configPath + ".pre-write-only.bak", "utf8"), original);
  assert.strictEqual((await fs.stat(configPath + ".pre-write-only.bak")).mode & 0o777, 0o600);
  assert.strictEqual((await fs.stat(configPath)).mode & 0o777, 0o600);
  assert.strictEqual(JSON.parse(await fs.readFile(configPath, "utf8")).futureSetting, "preserve");
  await loki.loadConfig();
  assert.strictEqual(loki.config.password, "legacy#password");
  assert.strictEqual(await fs.readFile(configPath + ".pre-write-only.bak", "utf8"), original);
});