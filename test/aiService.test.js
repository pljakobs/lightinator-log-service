const { test } = require("node:test");
const assert = require("node:assert/strict");
const { parseAIBackends, publicAIBackends, mergeAIBackends, DEFAULT_OLLAMA_NUM_CTX, DEFAULT_OLLAMA_TIMEOUT_MS } = require("../src/aiConfig");
const { AIService } = require("../src/aiService");
const http = require("node:http");

test("AI backend configuration supports all providers without exposing tokens", () => {
  const entries = ["gemini", "openai", "ollama"].map(type => ({ id: type, type, models: ["model-one", "model-two"], token: "private-token" }));
  const parsed = parseAIBackends(JSON.stringify(entries));
  assert.equal(parsed.length, 3);
  assert.equal(parsed.find(entry => entry.type === "gemini").timeoutMs, 60_000);
  assert.equal(parsed.find(entry => entry.type === "ollama").timeoutMs, DEFAULT_OLLAMA_TIMEOUT_MS);
  assert.equal(parsed.find(entry => entry.type === "ollama").numCtx, DEFAULT_OLLAMA_NUM_CTX);
  const publicEntries = publicAIBackends(parsed);
  assert.ok(publicEntries.every(entry => entry.tokenConfigured && !Object.hasOwn(entry, "token")));
  assert.ok(!JSON.stringify(publicEntries).includes("private-token"));
  const preserved = mergeAIBackends(JSON.stringify(publicEntries), parsed);
  assert.equal(preserved[0].token, "private-token");
  assert.throws(() => mergeAIBackends([{ ...publicEntries[0], baseUrl: "https://other.example.test" }], parsed), /replacing or clearing/);
  assert.equal(mergeAIBackends([{ ...publicEntries[0], baseUrl: "https://other.example.test", token: null }], parsed)[0].token, "");
});

test("AI backend configuration rejects unsafe protocols, credentials, identifiers, and multiline tokens", () => {
  const valid = { id: "local", type: "openai", baseUrl: "http://127.0.0.1:11434/v1", models: ["local-model"] };
  for (const entry of [
    { ...valid, baseUrl: "file:///tmp/model" }, { ...valid, baseUrl: "https://user:password@example.test" },
    { ...valid, id: "../invalid" }, { ...valid, token: "key\nINJECTED=value" }, { ...valid, models: [] },
  ]) assert.throws(() => parseAIBackends([entry]), /Invalid AI backend configuration/);
});

test("AI backend timeout is configurable and bounded", () => {
  const backend = { id: "ollama", type: "ollama", models: ["local-model"], timeoutMs: 900_000 };
  assert.equal(parseAIBackends([backend])[0].timeoutMs, 900_000);
  for (const timeoutMs of [0, 999, 3_600_001, 1.5, "900000"]) {
    assert.throws(() => parseAIBackends([{ ...backend, timeoutMs }]), /Invalid AI backend configuration/);
  }
});

test("Ollama context size is configurable and bounded", () => {
  const backend = { id: "ollama", type: "ollama", models: ["local-model"], numCtx: 65_536 };
  assert.equal(parseAIBackends([backend])[0].numCtx, 65_536);
  for (const numCtx of [1_024, 131_073, 1.5, "65536"]) {
    assert.throws(() => parseAIBackends([{ ...backend, numCtx }]), /Invalid AI backend configuration/);
  }
});

test("streamed Ollama output uses configured context and forwards only response content", async () => {
  const service = new AIService({ apiKey: "", backends: [
    { id: "ollama", type: "ollama", models: ["local"], numCtx: 65_536 },
  ] });
  service.backends[0].client.chat = async function* (options) {
    assert.equal(options.stream, true);
    assert.equal(options.options.num_ctx, 65_536);
    yield { message: { content: "Visible analysis ", thinking: "private reasoning" } };
    yield { message: { content: "continues." } };
  };
  const updates = [];
  const result = await service._generateWithFallback("prompt", update => updates.push(update));
  assert.equal(result, "Visible analysis continues.");
  assert.deepEqual(updates.filter(update => update.type === "token").map(update => update.text), ["Visible analysis ", "continues."]);
  assert.ok(!JSON.stringify(updates).includes("private reasoning"));
});

test("provider fallback reaches OpenAI-compatible and native Ollama HTTP APIs in order", async context => {
  const paths = [];
  const server = http.createServer((request, response) => {
    paths.push(request.url);
    request.resume();
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/v1/chat/completions") {
      response.statusCode = 500;
      response.end(JSON.stringify({ error: { message: "try next backend" } }));
    } else response.end(JSON.stringify({ model: "local", message: { role: "assistant", content: "local final response" }, done: true }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise(resolve => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const service = new AIService({ apiKey: "", backends: [
    { id: "openai", type: "openai", baseUrl: baseUrl + "/v1", models: ["first", "second"] },
    { id: "ollama", type: "ollama", baseUrl, models: ["local"] },
  ] });
  assert.equal(await service._generateWithFallback("evidence"), "local final response");
  assert.deepEqual(paths, ["/v1/chat/completions", "/v1/chat/completions", "/api/chat"]);
});

test("Ollama request aborts at its configured timeout", async context => {
  const server = http.createServer((_request, response) => {
    setTimeout(() => {
      if (!response.destroyed) response.end(JSON.stringify({ message: { content: "too late" } }));
    }, 2500);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  context.after(() => {
    server.closeAllConnections();
    return new Promise(resolve => server.close(resolve));
  });
  const service = new AIService({ apiKey: "", backends: [
    { id: "slow-ollama", type: "ollama", baseUrl: `http://127.0.0.1:${server.address().port}`, models: ["local"], timeoutMs: 1000 },
  ] });
  const startedAt = Date.now();
  await assert.rejects(service._generateWithFallback("test prompt"), /All configured AI backends and models failed/);
  assert.ok(Date.now() - startedAt < 2200, "request should abort before the delayed response");
});

test("context analysis gathers requested ranges iteratively and returns only the final report", async () => {
  const service = new AIService({ apiKey: "", backends: [], contextRounds: 3 });
  let passes = 0;
  const updates = [];
  service.runPass1 = async ({ codeSnippets, onProgress }) => {
    passes++;
    onProgress?.({ type: "reset", model: "local" });
    onProgress?.({ type: "token", text: "private Pass 1 analysis" });
    return codeSnippets.length === 1 ? 'Evidence gaps\n```json\n[{"file":"src/caller.cpp","start_line":10,"end_line":20,"priority":"required"}]\n```' : "Complete internal evidence\n```json\n[]\n```";
  };
  service.runPass2 = async evidence => {
    assert.equal(evidence.supplementalSnippets.length, 2);
    assert.equal(evidence.mapSymbols, "map evidence");
    assert.equal(evidence.disassembly, "instruction evidence");
    assert.equal(evidence.decodedText, "original crash");
    return "Final verified report";
  };
  const result = await service.analyzeCrash({
    decodedText: "original crash", mapSymbols: "map evidence", disassembly: "instruction evidence",
    codeSnippets: [{ repo: "app", file: "main.cpp", targetLine: 1, snippet: "initial source" }], repoPaths: { app: "/repo" },
    onProgress: update => updates.push(update),
    harvester: { getContextFiles: async requests => {
      assert.equal(requests[0].start_line, 10);
      return [{ repo: "app", file: "src/caller.cpp", startLine: 10, stopLine: 20, snippet: "caller source" }];
    } },
  });
  assert.equal(result, "Final verified report");
  assert.equal(passes, 2);
  assert.ok(updates.some(update => update.stage === "evidence-model"));
  assert.ok(!JSON.stringify(updates).includes("private Pass 1 analysis"));
});

test("context rounds and source budget are bounded and unresolved context is reported", async () => {
  const service = new AIService({ apiKey: "", backends: [], contextRounds: 0, contextBytes: 1024 });
  service.runPass1 = async () => '```json\n[{"file":"missing.cpp"}]\n```';
  service.runPass2 = async ({ pass1Result, supplementalSnippets }) => {
    assert.match(pass1Result, /Maximum context rounds/);
    assert.match(pass1Result, /Source omitted due to context budget/);
    assert.equal(supplementalSnippets.length, 0);
    return "insufficient evidence";
  };
  assert.equal(await service.analyzeCrash({ codeSnippets: [{ file: "large.cpp", snippet: "x".repeat(2000) }], harvester: {}, repoPaths: {} }), "insufficient evidence");
});