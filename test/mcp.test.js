const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");
const { once } = require("node:events");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = require("@modelcontextprotocol/sdk/inMemory.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");
const { createMcpServer, LogServiceClient, MAX_RESULT_BYTES } = require("../src/mcp");

const ip = "10.0.0.1";
const rows = [
  { id: 10, boot: 1, receivedAt: "2026-01-01T10:00:00Z", message: "old boot" },
  { id: 20, boot: 2, receivedAt: "2026-01-01T10:10:00Z", message: "firmware V1 about to fail", gitVersion: "V1" },
  { id: 21, boot: 2, receivedAt: "2026-01-01T10:11:00Z", message: "last evidence before reset" },
  { id: 30, boot: 3, receivedAt: "2026-01-01T11:00:00Z", message: "new boot, firmware V2" },
  { id: 31, boot: 3, receivedAt: "2026-01-01T11:05:00Z", message: "reporting previous crash" },
  { id: 40, boot: 4, receivedAt: "2026-01-01T12:00:00Z", message: "newest boot is not the reporting boot" },
];
const boots = [4, 3, 2, 1].map(boot => {
  const entries = rows.filter(row => row.boot === boot);
  return {
    boot,
    firstId: entries[0].id,
    lastId: entries.at(-1).id,
    startedAt: entries[0].receivedAt,
    endedAt: entries.at(-1).receivedAt,
  };
});

async function fixture(t, override = () => undefined, stdio = false, serverOptions = {}) {
  const requests = [];
  const api = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams) });
    const custom = override(url, res, req);
    if (custom === true) return;
    let data = custom;
    if (data === undefined) {
      switch (url.pathname) {
        case "/api/v1/controllers": data = { items: [{ ip, name: "test controller" }] }; break;
        case "/api/v1/boots": data = { items: boots }; break;
        case "/api/v1/crashes": data = { items: [{ id: 31, ip, boot: 3, receivedAt: rows[4].receivedAt }], total: 1 }; break;
        case "/api/v1/crashes/31/artifacts":
          data = { id: 31, ip, gitVersion: "V2", soc: "esp32", buildType: "debug", elf: { present: false }, map: { present: false } };
          break;
        case "/api/v1/logs/31/crash-decode":
          data = { id: 31, crashDecode: "PC: firmware.cpp:42", rawDump: "raw crash", gitVersion: "V2", smingVersion: "S1", soc: "esp32", buildType: "debug" };
          break;
        case "/api/v1/logs": {
          const before = Number(url.searchParams.get("before") || 0);
          const from = Number(url.searchParams.get("from") || 0);
          const limit = Number(url.searchParams.get("limit") || 100);
          let items = url.searchParams.get("ip") === ip ? rows : [];
          items = from ? items.filter(row => row.id >= from).slice(0, limit)
            : items.filter(row => !before || row.id < before).slice(-limit);
          data = {
            items, total: rows.length,
            nextBefore: items.length && rows.some(row => row.id < items[0].id) ? items[0].id : null,
            nextAfter: null,
          };
          break;
        }
        case "/api/v1/search": data = { query: url.searchParams.get("q"), snippets: [], total: 0 }; break;
        case "/api/v1/logs/download":
          res.writeHead(200, { "Content-Type": "text/plain" });
          res.end("2026-01-01T10:11:00Z last evidence before reset\n");
          return;
        default:
          res.writeHead(404);
          res.end();
          return;
      }
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
  });
  api.listen(0, "127.0.0.1");
  await once(api, "listening");
  t.after(() => new Promise(resolve => {
    api.close(resolve);
    api.closeAllConnections();
  }));
  const baseUrl = `http://127.0.0.1:${api.address().port}`;
  const client = new Client({ name: "test", version: "1.0.0" });
  if (stdio) {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.resolve(__dirname, "../src/mcp.js")],
      env: { ...process.env, LIGHTINATOR_LOG_URL: baseUrl },
      stderr: "pipe",
    });
    await client.connect(transport);
  } else {
    const server = createMcpServer({ baseUrl, ...serverOptions });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    t.after(() => server.close());
  }
  t.after(() => client.close());
  const call = (name, args = {}) => client.callTool({ name, arguments: args });
  return {
    client, call, requests, baseUrl,
    data: async (name, args) => {
      const result = await call(name, args);
      assert.notEqual(result.isError, true, result.content[0].text);
      const envelope = JSON.parse(result.content[0].text);
      assert.match(envelope.evidenceGuidance, /AFTER reboot/);
      return envelope.data;
    },
  };
}

test("MCP advertises eight read-only tools, the decode tools and crash timing instructions", async t => {
  const { client } = await fixture(t);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(tool => tool.name).sort(), [
    "decode_crash_with_artifacts", "get_boot_logs", "get_crash_details", "get_log_window", "get_recent_logs",
    "list_boots", "list_controllers", "list_crashes", "rerun_crash_decode", "search_logs",
  ]);
  for (const tool of tools) {
    assert.equal(tool.annotations.readOnlyHint, !["decode_crash_with_artifacts", "rerun_crash_decode"].includes(tool.name));
    assert.equal(tool.annotations.destructiveHint, false);
  }
  assert.match(client.getInstructions(), /crash happened before the reporting boot/);
});

test("crash details separate delayed report arrival from the preceding boot, not the newest boot", async t => {
  const { data, requests } = await fixture(t);
  const result = await data("get_crash_details", { ip, id: 31, limit: 1 });
  assert.deepEqual(result.timing, {
    reportReceivedAt: rows[4].receivedAt,
    reportingBoot: 3,
    likelyCrashedBoot: 2,
    crashOccurredAt: null,
    attribution: "inferred-preceding-boot",
    lastObservedPreCrashLogAt: rows[2].receivedAt,
    explanation: result.timing.explanation,
  });
  assert.equal(result.crashDecode, "PC: firmware.cpp:42");
  assert.equal(result.rawDump, "raw crash");
  assert.equal(result.reportedBuildMetadata.gitVersion, "V2");
  assert.equal(result.reportedBuildMetadata.verifiedForCrashedBoot, false);
  assert.deepEqual(result.preCrashLogs.items.map(row => row.id), [21]);
  assert.equal(result.preCrashLogs.nextBefore, 21);
  assert.equal(result.preCrashLogs.truncated, true);
  const older = await data("get_boot_logs", { ip, boot: 2, limit: 1, before: result.preCrashLogs.nextBefore });
  assert.deepEqual(older.items.map(row => row.id), [20]);
  assert.equal(older.items[0].gitVersion, "V1");
  assert.equal(older.nextBefore, null);
  assert.equal(older.truncated, false);
  assert.ok(requests.every(req => req.method === "GET"));
});

test("missing preceding boot is explicit, never substituted with another retained boot", async t => {
  const { data } = await fixture(t, url => url.pathname.endsWith("/boots")
    ? { items: boots.filter(item => item.boot !== 2) } : undefined);
  const result = await data("get_crash_details", { ip, id: 31 });
  assert.equal(result.timing.reportingBoot, 3);
  assert.equal(result.timing.likelyCrashedBoot, null);
  assert.equal(result.timing.crashOccurredAt, null);
  assert.equal(result.timing.attribution, "unknown-preceding-boot-unavailable");
  assert.equal(result.preCrashLogs, null);
});

test("unknown reporting boot cannot be attributed", async t => {
  const { data } = await fixture(t, url => url.pathname === "/api/v1/logs"
    ? { items: [{ ...rows[4], boot: undefined }] } : undefined);
  const result = await data("get_crash_details", { ip, id: 31 });
  assert.equal(result.timing.reportingBoot, null);
  assert.equal(result.timing.likelyCrashedBoot, null);
});

test("all tools map to bounded GETs, preserve cursors, and return empty evidence honestly", async t => {
  const { data, requests } = await fixture(t);
  assert.equal((await data("list_controllers")).items[0].ip, ip);
  assert.equal((await data("list_boots", { ip })).items[0].boot, 4);
  assert.equal((await data("list_crashes", { ip, limit: 2 })).items[0].boot, 3);
  const logs = await data("get_recent_logs", { ip, before: 31, limit: 2 });
  assert.deepEqual(logs.items.map(row => row.id), [21, 30]);
  assert.equal(logs.nextBefore, 21);
  assert.deepEqual((await data("get_recent_logs", { ip, from: 30, limit: 1 })).items.map(row => row.id), [30]);
  const search = await data("search_logs", { query: "panic & restart", context: 1 });
  assert.deepEqual(search.snippets, []);
  assert.equal(search.total, 0);
  const window = await data("get_log_window", { ip, start: "2026-01-01T10:00:00Z", end: "2026-01-01T11:00:00Z" });
  assert.match(window.text, /last evidence/);
  assert.equal(window.truncated, false);
  assert.ok(requests.every(req => req.method === "GET"));
  const query = requests.find(req => req.path.endsWith("/search")).query;
  assert.deepEqual(query, { q: "panic & restart", limit: "25", context: "1" });
});

test("invalid inputs and unavailable boots surface errors without writes", async t => {
  const { call, requests } = await fixture(t);
  for (const [name, args] of [
    ["get_recent_logs", { ip, limit: 501 }],
    ["get_crash_details", { ip, id: "../service-config" }],
    ["get_recent_logs", { ip, before: -1 }],
    ["get_log_window", { ip, start: "bad", end: "bad" }],
    ["get_log_window", { ip, start: "2026-01-02T00:00:00Z", end: "2026-01-01T00:00:00Z" }],
    ["get_log_window", { ip, start: "2026-01-01T00:00:00Z" }],
    ["get_log_window", { ip, minutes: 5, start: "2026-01-01T00:00:00Z", end: "2026-01-02T00:00:00Z" }],
    ["get_log_window", { ip, boot: 0, minutes: 5 }],
    ["get_log_window", { ip, boot: 1 }],
    ["get_log_window", { ip, minutes: 0 }],
    ["get_log_window", { ip, terms: [" "] }],
  ]) {
    assert.equal((await call(name, args)).isError, true);
  }
  assert.equal(requests.length, 0);
  assert.equal((await call("get_boot_logs", { ip, boot: 99 })).isError, true);
  const wrongController = await call("get_crash_details", { ip: "10.0.0.2", id: 31 });
  assert.equal(wrongController.isError, true);
  assert.match(wrongController.content[0].text, /not available for 10\.0\.0\.2/);
});

test("HTTP failure, invalid JSON, redirects and network errors are tool errors", async t => {
  const { call, requests } = await fixture(t, (url, res) => {
    if (url.pathname.endsWith("/controllers")) {
      res.writeHead(503);
      res.end();
    } else if (url.pathname.endsWith("/boots")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("not json");
    } else if (url.pathname.endsWith("/crashes")) {
      res.writeHead(302, { Location: "/api/v1/service-config/restart" });
      res.end();
    } else {
      res.destroy();
    }
    return true;
  });
  for (const [name, args] of [
    ["list_controllers", {}], ["list_boots", { ip }], ["list_crashes", {}], ["get_recent_logs", { ip }],
  ]) {
    const result = await call(name, args);
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /failed/);
  }
  assert.ok(!requests.some(req => req.path.includes("restart")));
});

test("large outputs are explicitly truncated and final serialized content stays within 64 KiB", async t => {
  const { call, data } = await fixture(t, (url, res) => {
    if (url.pathname.endsWith("/download")) {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("2026-01-01T10:11:00Z " + "a".repeat(100_000) + "\n");
      return true;
    }
    return { items: [{ message: "\u0000".repeat(100_000) }] };
  });
  const result = await call("get_recent_logs", { ip });
  assert.ok(Buffer.byteLength(result.content[0].text) <= MAX_RESULT_BYTES);
  const envelope = JSON.parse(result.content[0].text);
  assert.equal(envelope.truncated, true);
  assert.match(envelope.continuationHint, /smaller|fewer/);
  assert.ok(envelope.dataPreview);
  const window = await data("get_log_window", { ip, start: "2026-01-01T10:00:00Z", end: "2026-01-01T11:00:00Z" });
  assert.equal(window.truncated, true);
  assert.equal(window.returnedEntries, 0);
  assert.equal(window.matchedEntries, 1);
  assert.equal(window.scanComplete, true);
  assert.deepEqual(window.truncationReasons, ["output-byte-limit"]);
  assert.match(window.continuationHint, /Narrow/);
});

test("last N minutes uses connector time and exactly one HTTP request, defaulting to five", async t => {
  const { data, requests } = await fixture(t);
  for (const minutes of [undefined, 5, 0.5, 60]) {
    const before = Date.now();
    const window = await data("get_log_window", { ip, ...(minutes === undefined ? {} : { minutes }) });
    const after = Date.now();
    assert.ok(Date.parse(window.window.end) >= before && Date.parse(window.window.end) <= after);
    assert.equal(Date.parse(window.window.end) - Date.parse(window.window.start), (minutes ?? 5) * 60_000);
    assert.equal(window.scannedEntries, 1);
    assert.equal(window.matchedEntries, 1);
    assert.equal(window.returnedEntries, 1);
    assert.equal(window.scanComplete, true);
    assert.equal(window.lastScannedReceivedAt, "2026-01-01T10:11:00Z");
    const request = requests.at(-1);
    assert.equal(request.path, "/api/v1/logs/download");
    assert.deepEqual(request.query, { ip, scope: "range", ...window.window });
  }
  assert.equal(requests.length, 4);
});

test("boot offsets 0, -1, -2 are resolved inside one tool call and filtered with the same options", async t => {
  const { data, requests } = await fixture(t);
  for (const offset of [0, -1, -2]) {
    const window = await data("get_log_window", { ip, boot: offset, terms: ["EVIDENCE"] });
    assert.equal(window.bootOffset, offset);
    assert.equal(window.boot, 4 + offset);
    assert.equal(window.window.start, boots[-offset].startedAt);
    assert.equal(window.window.end, boots[-offset].endedAt);
    assert.equal(window.returnedEntries, 1);
    assert.equal(requests.at(-2).path, "/api/v1/boots");
    assert.deepEqual(requests.at(-1).query, { ip, scope: "boot", boot: String(4 + offset) });
  }
  assert.equal(requests.length, 6);
});

test("missing boot offsets fail rather than substituting another retained boot", async t => {
  const { call, requests } = await fixture(t, url => url.pathname.endsWith("/boots")
    ? { items: boots.filter(item => item.boot !== 3) } : undefined);
  const result = await call("get_log_window", { ip, boot: -1 });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Relative boot -1 is not available/);
  assert.equal(requests.length, 1);
});

test("terms support literal any/all and exclusions on complete multiline entries, not export headers", async t => {
  const text = [
    "# Controller: ERROR",
    "---- boot 3 ----",
    "2026-01-01T10:10:00Z WiFi ERROR failed",
    "  stack: reset.*",
    "2026-01-01T10:11:00Z ram warning",
    "2026-01-01T10:12:00Z wifi error noisy",
    "",
  ].join("\n");
  const { data } = await fixture(t, (_url, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end(text);
    return true;
  });
  const any = await data("get_log_window", { ip, minutes: 5, terms: ["error", "WARNING"] });
  assert.equal(any.returnedEntries, 3);
  assert.equal(any.scannedEntries, 3);
  assert.match(any.text, /---- boot 3 ----/);
  const all = await data("get_log_window", { ip, terms: ["wifi", "ERROR"], match: "all", excludeTerms: ["NOISY"] });
  assert.equal(all.returnedEntries, 1);
  assert.match(all.text, /stack: reset\.\*/);
  assert.ok(!all.text.includes("noisy"));
  const literal = await data("get_log_window", { ip, terms: ["reset.*"] });
  assert.equal(literal.returnedEntries, 1);
  const noMatch = await data("get_log_window", { ip, terms: ["controller"] });
  assert.equal(noMatch.text, "");
  assert.equal(noMatch.matchedEntries, 0);
  assert.equal(noMatch.scanComplete, true);
  assert.equal(noMatch.truncated, false);
});

test("filtering occurs beyond the old 32 KiB cutoff and before entry/output limits", async t => {
  const { data } = await fixture(t, (_url, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end([
      "2026-01-01T10:10:00Z " + "noise ".repeat(10_000),
      "2026-01-01T10:11:00Z wanted first",
      "2026-01-01T10:12:00Z wanted second",
      "",
    ].join("\n"));
    return true;
  });
  const window = await data("get_log_window", { ip, terms: ["wanted"], limit: 1 });
  assert.equal(window.scannedEntries, 3);
  assert.equal(window.matchedEntries, 2);
  assert.equal(window.returnedEntries, 1);
  assert.equal(window.scanComplete, true);
  assert.deepEqual(window.truncationReasons, ["entry-limit"]);
  assert.equal(window.text, "2026-01-01T10:11:00Z wanted first\n");
});

test("upstream truncation omits the incomplete multiline entry and does not claim complete matches", async t => {
  const { data } = await fixture(t, (_url, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("2026-01-01T10:10:00Z wanted complete\n2026-01-01T10:11:00Z partial\n" + "x".repeat(2 * 1024 * 1024));
    return true;
  });
  const window = await data("get_log_window", { ip, terms: ["wanted"] });
  assert.equal(window.scanComplete, false);
  assert.equal(window.scannedEntries, 1);
  assert.equal(window.matchedEntries, 1);
  assert.equal(window.text, "2026-01-01T10:10:00Z wanted complete\n");
  assert.deepEqual(window.truncationReasons, ["upstream-byte-limit"]);
  assert.equal(window.truncated, true);
});

test("window output including escaped text and metadata stays below the final 64 KiB budget", async t => {
  const { call } = await fixture(t, (_url, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end(Array.from({ length: 100 }, () => "2026-01-01T10:10:00Z " + "\u0000".repeat(200)).join("\n") + "\n");
    return true;
  });
  const result = await call("get_log_window", { ip });
  assert.ok(Buffer.byteLength(result.content[0].text) <= MAX_RESULT_BYTES);
  const envelope = JSON.parse(result.content[0].text);
  assert.equal(envelope.truncated, false, "structured data must survive without generic preview fallback");
  assert.equal(envelope.data.truncated, true);
  assert.ok(envelope.data.returnedEntries > 0);
  assert.equal(envelope.data.matchedEntries, 100);
});

test("empty exports are complete empty results, malformed exports are errors", async t => {
  const { data, call } = await fixture(t, (url, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end(url.searchParams.get("ip") === ip
      ? "# Lightinator log export\n# (no log entries)\n"
      : "<html>proxy failure</html>");
    return true;
  });
  const window = await data("get_log_window", { ip });
  assert.equal(window.returnedEntries, 0);
  assert.equal(window.lastScannedReceivedAt, null);
  assert.equal(window.scanComplete, true);
  assert.equal(window.truncated, false);
  assert.equal((await call("get_log_window", { ip: "10.0.0.2" })).isError, true);
});

test("oversized upstream JSON is an error, not partial evidence", async t => {
  const { call } = await fixture(t, () => ({ message: "x".repeat(2 * 1024 * 1024) }));
  const result = await call("list_controllers");
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /exceeds 2 MiB/);
});

test("base URL validation rejects non-HTTP URLs and credentials", () => {
  for (const url of ["file:///etc/passwd", "http://user:password@localhost", "http://localhost/?q=x", "http://localhost/#x"]) {
    assert.throws(() => new LogServiceClient(url), /must be an HTTP/);
  }
});

test("standalone stdio process initializes and executes a tool without stdout noise", async t => {
  const { data } = await fixture(t, undefined, true);
  assert.equal((await data("list_controllers")).items[0].ip, ip);
});

test("relative time and boot filters work against the existing real service export API", async t => {
  const { startServer, bootLines } = require("./e2e/server");
  const srv = await startServer();
  t.after(() => srv.stop());
  await srv.sendSyslog(bootLines([101, 202, 303], 3));
  const server = createMcpServer({ baseUrl: srv.baseUrl });
  const client = new Client({ name: "export-integration", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  t.after(() => server.close());
  await client.connect(clientTransport);
  t.after(() => client.close());
  const call = async args => {
    const result = await client.callTool({ name: "get_log_window", arguments: { ip: "127.0.0.1", ...args } });
    assert.notEqual(result.isError, true, result.content[0].text);
    return JSON.parse(result.content[0].text).data;
  };
  const recent = await call({ minutes: 5, terms: ["nonce 202"] });
  assert.equal(recent.scannedEntries, 9);
  assert.equal(recent.matchedEntries, 3);
  assert.equal(recent.returnedEntries, 3);
  assert.match(recent.text, /nonce 202 message 0/);
  assert.ok(!recent.text.includes("nonce 303"));
  for (const [offset, nonce] of [[0, 303], [-1, 202], [-2, 101]]) {
    const window = await call({ boot: offset, terms: ["message"], excludeTerms: ["message 1"] });
    assert.equal(window.scannedEntries, 3);
    assert.equal(window.returnedEntries, 2);
    assert.equal(window.scanComplete, true);
    assert.equal(window.truncated, false);
    assert.match(window.text, new RegExp(`nonce ${nonce} message 0`));
    assert.match(window.text, new RegExp(`nonce ${nonce} message 2`));
    assert.ok(!window.text.includes("message 1"));
  }
});

test("decode_crash_with_artifacts streams local ELF then map and returns the rerun decode", async t => {
  const fs = require("node:fs");
  const os = require("node:os");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lls-mcp-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const elfPath = path.join(dir, "app.out");
  const mapPath = path.join(dir, "app.map");
  fs.writeFileSync(elfPath, Buffer.alloc(200_000, 7));
  fs.writeFileSync(mapPath, "map text");
  const uploads = [];
  const { call, client, requests } = await fixture(t, (url, res, req) => {
    const match = url.pathname.match(/^\/api\/v1\/crashes\/31\/artifacts\/(elf|map)$/);
    if (match) {
      let size = 0;
      req.on("data", chunk => { size += chunk.length; });
      req.on("end", () => {
        uploads.push({ kind: match[1], size, filename: req.headers["x-filename"], type: req.headers["content-type"] });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ id: 31, kind: match[1], gitVersion: "V2", soc: "esp32", buildType: "debug", size, sha256: "ab", originalName: "ignored" }));
      });
      return true;
    }
    if (url.pathname === "/api/v1/crashes/31/decode") return { id: 31, crashDecode: "PC: app.cpp:7", rawDump: "raw" };
    return undefined;
  });

  const progress = [];
  const response = await client.callTool({ name: "decode_crash_with_artifacts", arguments: { ip, id: 31, elfPath, mapPath } },
    undefined, { onprogress: update => progress.push(update.message) });
  assert.notEqual(response.isError, true, response.content[0].text);
  const result = JSON.parse(response.content[0].text).data;
  assert.deepEqual(progress, ["Uploading ELF", "Uploading map", "Decoding"]);
  assert.deepEqual(uploads, [
    { kind: "elf", size: 200_000, filename: "app.out", type: "application/octet-stream" },
    { kind: "map", size: 8, filename: "app.map", type: "application/octet-stream" },
  ]);
  assert.equal(result.crashDecode, "PC: app.cpp:7");
  assert.deepEqual(result.uploaded.map(item => [item.kind, item.size]), [["elf", 200_000], ["map", 8]]);
  assert.deepEqual(requests.filter(r => r.method !== "GET").map(r => `${r.method} ${r.path}`), [
    "PUT /api/v1/crashes/31/artifacts/elf", "PUT /api/v1/crashes/31/artifacts/map", "POST /api/v1/crashes/31/decode",
  ]);

  const relative = await call("decode_crash_with_artifacts", { ip, id: 31, elfPath: "app.out" });
  assert.equal(relative.isError, true);
  assert.match(relative.content[0].text, /absolute path/);
  const foreign = await call("decode_crash_with_artifacts", { ip: "10.0.0.2", id: 31, elfPath });
  assert.equal(foreign.isError, true);
  assert.match(foreign.content[0].text, /not available for 10\.0\.0\.2/);
});

test("hosted MCP returns quoted curl upload commands for the client's service URL", async t => {
  const { data, client } = await fixture(t, url => {
    if (url.pathname === "/api/v1/crashes/31/artifacts") {
      return { id: 31, ip, gitVersion: "V5.1-1-develop-dirty", soc: "esp32", buildType: "debug", elf: { present: false }, map: { present: false } };
    }
    return undefined;
  }, false, { transport: "http", publicUrl: "http://logs.example:4821/" });
  const names = (await client.listTools()).tools.map(tool => tool.name);
  assert.ok(names.includes("prepare_crash_artifact_upload"));
  assert.ok(!names.includes("decode_crash_with_artifacts"));

  const plan = await data("prepare_crash_artifact_upload", { ip, id: 31, elfPath: "/home/me/it's/app.out", mapPath: "/home/me/app.map" });
  assert.deepEqual(plan.commands, [
    "curl --fail-with-body -sS -T '/home/me/it'\\''s/app.out' -H 'Content-Type: application/octet-stream' -H 'X-Filename: app.out' 'http://logs.example:4821/api/v1/crashes/31/artifacts/elf'",
    "curl --fail-with-body -sS -T '/home/me/app.map' -H 'Content-Type: application/octet-stream' -H 'X-Filename: app.map' 'http://logs.example:4821/api/v1/crashes/31/artifacts/map'",
  ]);
  assert.equal(plan.expectedBuild.gitVersion, "V5.1-1-develop-dirty");
  assert.match(plan.next, /rerun_crash_decode/);
});

test("rerun_crash_decode checks the controller and returns the new decode", async t => {
  const { data, requests } = await fixture(t, url => {
    if (url.pathname === "/api/v1/crashes/31/decode") return { id: 31, crashDecode: "PC: app.cpp:7", rawDump: "raw" };
    return undefined;
  });
  const result = await data("rerun_crash_decode", { ip, id: 31 });
  assert.equal(result.crashDecode, "PC: app.cpp:7");
  assert.ok(requests.some(r => r.method === "POST" && r.path === "/api/v1/crashes/31/decode"));
});

test("rerun_crash_decode accepts archived crashes whose log row has expired", async t => {
  const { data, call, requests } = await fixture(t, url => {
    if (url.pathname === "/api/v1/logs") return { items: [], total: 0, nextBefore: null, nextAfter: null };
    if (url.pathname === "/api/v1/crashes/31/decode") return { id: 31, crashDecode: "PC: app.cpp:7", rawDump: "raw" };
    return undefined;
  });
  const result = await data("rerun_crash_decode", { ip, id: 31 });
  assert.equal(result.crashDecode, "PC: app.cpp:7");

  const unknown = await call("rerun_crash_decode", { ip, id: 32 });
  assert.equal(unknown.isError, true);
  assert.match(unknown.content[0].text, /Crash report 32 is not available for/);
  assert.equal(requests.filter(r => r.method === "POST").length, 1);
});
