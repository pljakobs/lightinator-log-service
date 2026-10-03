const { test } = require("node:test");
const assert = require("node:assert/strict");
const { FirmwareUpdater, branchFromVersion } = require("../src/firmwareUpdater");
const http = require("node:http");
const { startServer } = require("./e2e/server");

test("firmware catalogue uses new API fields and preserves hyphenated branches", async () => {
  const urls = [];
  const updater = new FirmwareUpdater({ apiUrl: "https://catalogue.example.test/api", fetchImpl: async url => {
    urls.push(url);
    return Response.json([{ version: "V5.0-10-experimental-externalui", soc: "esp8266", branch: "experimental-externalui", type: "debug", url: "/download/app.bin", comment: "release notes" }]);
  } });
  const entries = await updater.catalogue("versions", { soc: "esp8266", branch: "experimental-externalui", type: "debug" });
  assert.equal(branchFromVersion(entries[0].version), "experimental-externalui");
  assert.equal(entries[0].url, "https://catalogue.example.test/download/app.bin");
  assert.equal(new URL(urls[0]).pathname, "/api/firmware/versions");
});

test("firmware catalogue refuses credential URLs and untrusted artifact destinations", async () => {
  const updater = new FirmwareUpdater({ apiUrl: "https://catalogue.example.test/api", fetchImpl: async () =>
    Response.json([{ version: "V1", soc: "esp8266", branch: "develop", type: "debug", url: "https://other.example.test/app.bin" }]) });
  await assert.rejects(updater.catalogue("versions", { soc: "esp8266" }), /artifact host/);
  assert.throws(() => new FirmwareUpdater({ apiUrl: "https://user:password@example.test/api" }), /without embedded credentials/);
  await assert.rejects(updater.start("192.0.2.1", {}), error => error.status === 403);
});

test("firmware update sends one ROM command and only succeeds after version verification", async context => {
  const controller = { ip: "192.0.2.1" };
  let posts = 0;
  let updated = false;
  let auth;
  const updater = new FirmwareUpdater({ apiUrl: "https://catalogue.example.test/api", enabled: true, getController: ip => ip === controller.ip ? controller : null, pollMs: 1,
    fetchImpl: async (url, options) => {
      if (url.includes("/firmware/versions")) return Response.json([{ version: "V1.0-2-develop", soc: "esp8266", branch: "develop", type: "debug", url: "/app.bin" }]);
      if (url.endsWith("/info?v=2")) return Response.json({ device: { soc: "esp8266", id: "device" }, app: { git_version: updated ? "V1.0-2-develop" : "V1.0-1-develop", build_type: "debug" } });
      if (options.method === "POST") { posts++; auth = options.headers.Authorization; assert.deepEqual(JSON.parse(options.body), { rom: { url: "https://catalogue.example.test/app.bin" } }); updated = true; return Response.json({ code: 0 }); }
      return Response.json({ status: 2 });
    } });
  context.after(() => updater.stop());
  const job = await updater.start(controller.ip, { branch: "develop", type: "debug", version: "V1.0-2-develop", password: "one-shot-secret" });
  await new Promise(resolve => { const timer = setInterval(() => { if (updater.status(controller.ip, job.id).finishedAt) { clearInterval(timer); resolve(); } }, 1); });
  assert.equal(posts, 1);
  assert.equal(auth, "Basic " + Buffer.from("admin:one-shot-secret").toString("base64"));
  assert.equal(updater.status(controller.ip, job.id).state, "succeeded");
  assert.ok(!JSON.stringify([...updater.jobs.values()]).includes("one-shot-secret"));
  assert.equal(controller.gitVersion, "V1.0-2-develop");
});

test("network disconnects never count as successful installation and commands are not retried", async context => {
  let posts = 0;
  let submitted = false;
  const updater = new FirmwareUpdater({ apiUrl: "https://catalogue.example.test/api", enabled: true, getController: () => ({}), pollMs: 1, timeoutMs: 10,
    fetchImpl: async (url, options) => {
      if (url.includes("/firmware/versions")) return Response.json([{ version: "V1.0-2-develop", soc: "esp8266", branch: "develop", type: "debug", url: "/app.bin" }]);
      if (!submitted) {
        if (options.method === "POST") { posts++; submitted = true; throw new Error("response lost"); }
        return Response.json({ device: { soc: "esp8266" }, app: { git_version: "V1.0-1-develop", build_type: "debug" } });
      }
      throw new Error("unreachable");
    } });
  context.after(() => updater.stop());
  const job = await updater.start("192.0.2.1", { branch: "develop", type: "debug", version: "V1.0-2-develop" });
  await assert.rejects(updater.start("192.0.2.1", { branch: "develop", type: "debug", version: "V1.0-2-develop" }), error => error.status === 409);
  await new Promise(resolve => { const timer = setInterval(() => { if (updater.status("192.0.2.1", job.id).finishedAt) { clearInterval(timer); resolve(); } }, 1); });
  assert.equal(updater.status("192.0.2.1", job.id).state, "unverified");
  assert.equal(posts, 1);
});

test("HTTP firmware flow proxies only a known controller and catalogue release and never exposes its password", { timeout: 20000 }, async context => {
  let installed = "V1.0-1-develop";
  let updates = 0;
  let catalogBase;
  const device = http.createServer((request, response) => {
    response.setHeader("Content-Type", "application/json");
    if (request.url.startsWith("/info")) response.end(JSON.stringify({ device: { soc: "esp8266", id: "fixture" }, app: { git_version: installed, build_type: "debug" } }));
    else if (request.url === "/update" && request.method === "POST") {
      assert.equal(request.headers.authorization, "Basic " + Buffer.from("admin:private-ota-password").toString("base64"));
      let body = "";
      request.on("data", chunk => { body += chunk; });
      request.on("end", () => {
        assert.equal(JSON.parse(body).rom.url, catalogBase + "/download/rom0.bin");
        updates++; installed = "V1.0-2-develop"; response.end('{"code":0}');
      });
    } else if (request.url === "/update") response.end('{"status":2}');
    else if (request.url.startsWith("/hosts")) response.end('{"hosts":[]}');
    else if (request.url === "/data") response.end('{"controllers":[],"groups":[]}');
    else response.end('{}');
  });
  await new Promise(resolve => device.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise(resolve => device.close(resolve)));
  const catalog = http.createServer((request, response) => {
    response.setHeader("Content-Type", "application/json");
    const route = new URL(request.url, "http://fixture").pathname;
    response.end(JSON.stringify(route.endsWith("/branches") ? ["develop"] : route.endsWith("/types") ? ["debug"] :
      [{ version: "V1.0-2-develop", soc: "esp8266", branch: "develop", type: "debug", url: "/download/rom0.bin", comment: "fixture release" }]));
  });
  await new Promise(resolve => catalog.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise(resolve => catalog.close(resolve)));
  catalogBase = `http://127.0.0.1:${catalog.address().port}`;
  const server = await startServer({ controllers: [{ ip: "127.0.0.1", name: "fixture" }], env: {
    LLS_FIRMWARE_UPDATES_ENABLED: "true", LLS_FIRMWARE_API_URL: catalogBase + "/api", LLS_DISCOVERY_PORT: String(device.address().port), LLS_DISCOVERY_REFRESH_MS: "0",
  } });
  context.after(() => server.stop());
  const base = server.baseUrl + "/api/v1/controllers/127.0.0.1/firmware";
  const options = await (await fetch(base)).json();
  assert.equal(options.versions[0].version, "V1.0-2-develop");
  const body = { branch: "develop", type: "debug", version: "V1.0-2-develop", password: "private-ota-password" };
  let response = await fetch(base, { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://untrusted.example.test" }, body: JSON.stringify(body) });
  assert.equal(response.status, 403);
  assert.equal(updates, 0);
  response = await fetch(base, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  assert.equal(response.status, 202);
  const job = await response.json();
  assert.ok(!JSON.stringify(job).includes("private-ota-password"));
  await new Promise(resolve => setTimeout(resolve, 2200));
  const status = await (await fetch(base + "/" + job.id)).json();
  assert.equal(status.state, "succeeded");
  assert.equal(updates, 1);
  assert.ok(!server.getOutput().includes("private-ota-password"));
  assert.equal((await fetch(server.baseUrl + "/api/v1/controllers/127.0.0.2/firmware")).status, 404);
});

test("invalid OTA configuration disables updates without preventing HTTP startup", async context => {
  const server = await startServer({ env: { LLS_FIRMWARE_UPDATES_ENABLED: "true", LLS_FIRMWARE_API_URL: "file:///private/path", LLS_DISCOVERY_REFRESH_MS: "0" } });
  context.after(() => server.stop());
  const controllers = await (await fetch(server.baseUrl + "/api/v1/controllers")).json();
  assert.equal(controllers.firmwareUpdatesEnabled, false);
  assert.equal((await fetch(server.baseUrl + "/health")).status, 200);
  assert.ok(!server.getOutput().includes("/private/path"));
});