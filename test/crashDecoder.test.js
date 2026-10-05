const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { AIContextHarvester } = require("../src/aiContextHarvester");
const { CrashDecoder } = require("../src/crashDecoder");
const { execFileSync } = require("node:child_process");
const { openDatabase } = require("../src/db");
const { LogStorage } = require("../src/storage");

test("crash collection strips the firmware report prefix from ESP8266 stack rows", () => {
  const decoder = Object.create(CrashDecoder.prototype);
  decoder._collecting = new Map();
  decoder.discovery = null;
  const ip = "192.168.29.101";

  decoder.feed({ id: 1, sourceIp: ip, message: "Application::reportCrashDump: pc=0x4024afed sp=0x3fffffc0 excvaddr=0x00000000" });
  decoder.feed({ id: 2, sourceIp: ip, message: "Application::reportCrashDump: epc2=0x00000000 epc3=0x4024afed exccause=4 depc=0x00000000 reason=3" });
  decoder.feed({ id: 3, sourceIp: ip, message: "Application::reportCrashDump: Stack dump:" });
  decoder.feed({ id: 4, sourceIp: ip, message: "Application::reportCrashDump: 3fffffc0: 40001f46 00000007 3fffffd0 400005e1" });
  decoder.feed({ id: 5, sourceIp: ip, message: "Application::reportCrashDump: 3fffffd0: 4000df64 00000030 00000030 4000002c" });

  const state = decoder._collecting.get(ip);
  clearTimeout(state.timer);
  assert.deepEqual(state.lines.slice(-3), [
    "Stack dump:",
    "3fffffc0: 40001f46 00000007 3fffffd0 400005e1",
    "3fffffd0: 4000df64 00000030 00000030 4000002c",
  ]);
});

test("source context resolves build-machine paths and ANSI-colored assembly locations", async (context) => {
  const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "crash-context-"));
  context.after(() => fs.rm(cacheDir, { recursive: true, force: true }));
  const firmware = path.join(cacheDir, "firmware");
  const sming = path.join(cacheDir, "Sming");
  await fs.mkdir(path.join(firmware, "app"), { recursive: true });
  await fs.mkdir(path.join(sming, "Sming", "Arch"), { recursive: true });
  await fs.writeFile(path.join(firmware, "app", "main.cpp"), "void crash() {\n  dereference();\n}\n");
  await fs.writeFile(path.join(sming, "Sming", "Arch", "vectors.S"), "entry:\n  ret\n");
  const harvester = new AIContextHarvester({ cacheDir });
  const snippets = await harvester.extractSnippets(
    "crash at /build/esp_rgbww_firmware/app/main.cpp:2\n" +
    "entry at \x1b[35m/opt/Sming/Sming/Arch/vectors.S:2\x1b[0m\n" +
    "crash at /build/esp_rgbww_firmware/app/main.cpp:2",
    { Sming: sming, firmware },
  );
  assert.equal(snippets.length, 2);
  assert.equal(snippets[0].repo, "firmware");
  assert.match(snippets[0].snippet, /2:  dereference\(\);/);
  assert.equal(snippets[1].repo, "Sming");
  assert.match(snippets[1].snippet, /2:  ret/);
});

test("decoding reuses harvested repositories and keeps assembly alongside source context", async () => {
  const decoder = Object.create(CrashDecoder.prototype);
  const repoPaths = { Sming: "/cache/Sming", "esp-rgbww-firmware": "/cache/firmware" };
  const codeSnippets = [{ repo: "esp-rgbww-firmware", file: "app/main.cpp", targetLine: 2, snippet: "2:  dereference();" }];
  decoder._runDecode = async (cfg, elfPath, lines, repos) => {
    assert.equal(repos, repoPaths);
    return "PC: 0x40201000 crash at app/main.cpp:2\nDisassembly around 0x40201000:\n40201000: l32i a2, a3, 0";
  };
  decoder.harvester = {
    extractSnippets: async (decoded, repos) => {
      assert.equal(repos, repoPaths);
      assert.match(decoded, /l32i a2, a3, 0/);
      return codeSnippets;
    },
  };
  const result = await decoder._decodeWithContext({}, "app.elf", [], repoPaths);
  assert.equal(result.codeSnippets, codeSnippets);
  assert.match(result.decoded, /Source context:\n.*app\/main.cpp:2\n2:  dereference\(\);/);
  assert.match(result.decoded, /l32i a2, a3, 0/);
});

test("repository references cannot execute shell commands or inject Git options", async (context) => {
  const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'crash-git-"'));
  context.after(() => fs.rm(cacheDir, { recursive: true, force: true }));
  const repoPath = path.join(cacheDir, "firmware");
  const git = args => execFileSync("git", args, { stdio: "ignore" });
  git(["init", repoPath]);
  git(["-C", repoPath, "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "--allow-empty", "-m", "fixture"]);
  git(["-C", repoPath, "remote", "add", "origin", repoPath]);
  const harvester = new AIContextHarvester({ cacheDir });
  assert.equal(await harvester.ensureRepo("firmware", "https://example.test/firmware.git", "HEAD"), repoPath);
  git(["-C", repoPath, "update-ref", "refs/remotes/origin/remote-only", "HEAD"]);
  assert.equal(await harvester.ensureRepo("firmware", "https://example.test/firmware.git", "remote-only"), repoPath);
  const marker = path.join(cacheDir, "injected");
  await assert.rejects(harvester.ensureRepo("firmware", "https://example.test/firmware.git", `HEAD$(touch '${marker}')`));
  await assert.rejects(fs.access(marker));
  await assert.rejects(harvester.ensureRepo("firmware", "https://example.test/firmware.git", "--help"), /Invalid repository reference/);
  await assert.rejects(harvester.ensureRepo("../escape", "https://example.test/firmware.git", "HEAD"), /Invalid repository name/);
  await assert.rejects(harvester.ensureRepo("firmware", "ext::unsafe", "HEAD"), /Unsupported repository URL/);
});

test("context requests cannot escape repositories through traversal or symlinks", async (context) => {
  const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "crash-paths-"));
  context.after(() => fs.rm(cacheDir, { recursive: true, force: true }));
  const repoPath = path.join(cacheDir, "firmware");
  await fs.mkdir(repoPath);
  await fs.writeFile(path.join(cacheDir, "outside.cpp"), "private outside content");
  await fs.writeFile(path.join(repoPath, "safe.cpp"), "safe source");
  await fs.symlink(path.join(cacheDir, "outside.cpp"), path.join(repoPath, "linked.cpp"));
  const harvester = new AIContextHarvester({ cacheDir });
  const snippets = await harvester.getContextFiles([
    { path: "../outside.cpp" }, { path: "linked.cpp" }, { file: "safe.cpp" }, null,
  ], { firmware: repoPath });
  assert.equal(snippets.length, 1);
  assert.equal(snippets[0].snippet, "1:safe source");
  assert.deepEqual(await harvester.extractSnippets("linked.cpp:1 ../outside.cpp:1", { firmware: repoPath }), []);
});

test("source repositories use the firmware version tag and tolerate unavailable sources", async () => {
  const decoder = Object.create(CrashDecoder.prototype);
  const calls = [];
  decoder.harvester = {
    ensureRepo: async (...args) => {
      calls.push(args);
      if (args[0] === "Sming") throw new Error("offline");
      return "/cache/firmware";
    },
  };
  const repos = await decoder._getSourceRepos("V1.2.3-4-develop");
  assert.deepEqual(repos, { "esp-rgbww-firmware": "/cache/firmware" });
  assert.deepEqual(calls[1], ["esp-rgbww-firmware", "https://github.com/pljakobs/esp_rgbww_firmware.git", "v1.2.3-4-develop"]);
  await decoder._getSourceRepos("V1.2.3-4-develop", "sming-build-tag");
  assert.deepEqual(calls[2], ["Sming", "https://github.com/pljakobs/Sming.git", "sming-build-tag"]);
  decoder._runDecode = async () => "decoded without source";
  decoder.harvester.extractSnippets = async () => [];
  const result = await decoder._decodeWithContext({}, "app.elf", [], {});
  assert.equal(result.decoded, "decoded without source");
});

test("automatic and manual requests serialize checkout, decode, AI passes, and storage", { timeout: 2000 }, async () => {
  const decoder = Object.create(CrashDecoder.prototype);
  const events = [];
  let releaseDecode;
  const decodeGate = new Promise(resolve => { releaseDecode = resolve; });
  let queue = Promise.resolve();
  decoder.aiService = {
    enqueue: task => {
      const result = queue.then(task);
      queue = result.catch(() => {});
      return result;
    },
    isAvailable: () => true,
    runPass1: async ({ gitVersion }) => {
      events.push(`pass1:${gitVersion}`);
      return gitVersion;
    },
    runPass2: async ({ pass1Result }) => {
      events.push(`pass2:${pass1Result}`);
      return "analysis";
    },
    analyzeCrash: async ({ gitVersion }) => {
      events.push(`pass1:${gitVersion}`, `pass2:${gitVersion}`);
      return "final analysis";
    },
  };
  decoder.elfCacheDir = "/cache/elfs";
  decoder.elfBaseUrl = "http://example.test";
  decoder._resolveTargetInfo = async () => ({ git_version: "auto", soc: "esp8266" });
  decoder._ensureElf = async () => {};
  decoder._ensureScript = async () => {};
  decoder._getSourceRepos = async version => {
    events.push(`checkout:${version}`);
    return { version };
  };
  decoder._decodeWithContext = async (cfg, elfPath, lines, repos) => {
    events.push(`decode:${repos.version}`);
    if (repos.version === "auto") await decodeGate;
    events.push(`snippets:${repos.version}`);
    return { decoded: "decoded", codeSnippets: [] };
  };
  decoder.harvester = { fetchMapFile: async () => null };
  decoder.storage = {
    getCrashRecord: () => {
      events.push("read:manual");
      return { raw: "dump", gitVersion: "manual", soc: "esp8266" };
    },
    updateCrashDecode: async id => { events.push(`store:${id}`); },
  };
  decoder.onDecoded = () => { events.push("notify:auto"); };

  const automatic = decoder._decode("192.0.2.1", "auto", {}, ["dump"]);
  const manual = decoder.analyzeRecord("manual");
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events, ["store:auto", "checkout:auto", "decode:auto"]);
  releaseDecode();
  await Promise.all([automatic, manual]);
  assert.deepEqual(events, [
    "store:auto", "checkout:auto", "decode:auto", "snippets:auto", "pass1:auto", "pass2:auto", "store:auto", "notify:auto",
    "read:manual", "checkout:manual", "decode:manual", "snippets:manual", "pass1:manual", "pass2:manual", "store:manual",
  ]);
});

test("decoding without an AI service is serialized and a failed task does not block the queue", async () => {
  const decoder = Object.create(CrashDecoder.prototype);
  decoder._decodeQueue = Promise.resolve();
  const events = [];
  let releaseFirst;
  const firstGate = new Promise(resolve => { releaseFirst = resolve; });
  decoder._decodeRecord = async (ip, id) => {
    events.push(`start:${id}`);
    if (id === 1) {
      await firstGate;
      throw new Error("decode failed");
    }
    events.push(`end:${id}`);
  };
  decoder._analyzeRecord = async () => {
    events.push("manual");
    throw new Error("AI service is not configured.");
  };
  const first = decoder._decode("192.0.2.1", 1, {}, []);
  const firstFailure = assert.rejects(first, /decode failed/);
  const manual = decoder.analyzeRecord(2);
  const manualFailure = assert.rejects(manual, /AI service is not configured/);
  const last = decoder._decode("192.0.2.1", 3, {}, []);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events, ["start:1"]);
  releaseFirst();
  await Promise.all([firstFailure, manualFailure, last]);
  assert.deepEqual(events, ["start:1", "manual", "start:3", "end:3"]);
});

test("manual re-analysis uses stored raw crash and original release build after firmware changes", async context => {
  const db = openDatabase(":memory:");
  context.after(() => db.close());
  const storage = new LogStorage({ db, dataDir: "/nonexistent" });
  const id = await storage.append("192.0.2.1", { message: "trigger" });
  await storage.updateCrashDecode(id, "old decoded output and AI text", {
    rawDump: "original dump\noriginal stack", gitVersion: "V1.0.0-1-develop", soc: "esp8266", buildType: "release",
  });
  const decoder = Object.create(CrashDecoder.prototype);
  Object.assign(decoder, { storage, db, elfCacheDir: "/cache", elfBaseUrl: "http://example.test" });
  decoder._resolveTargetInfo = async () => { assert.fail("Current controller metadata must not be used"); };
  decoder._ensureElf = async url => { assert.match(url, /V1\.0\.0-1-develop\/esp8266\/release\/app_0.out$/); };
  decoder._ensureScript = async () => {};
  decoder._getSourceRepos = async () => ({});
  decoder._decodeWithContext = async (cfg, elfPath, lines) => {
    assert.deepEqual(lines, ["original dump", "original stack"]);
    return { decoded: "decoded original dump", codeSnippets: [] };
  };
  decoder.harvester = { fetchMapFile: async () => null };
  decoder.aiService = { isAvailable: () => true, analyzeCrash: async () => "final report" };
  assert.match(await decoder._analyzeRecord(id), /decoded original dump/);
  assert.equal(storage.getCrashRecord(id).raw, "original dump\noriginal stack");
});

test("decoder rerun uses stored firmware and Sming tags without requiring AI", async context => {
  const db = openDatabase(":memory:");
  context.after(() => db.close());
  const storage = new LogStorage({ db, dataDir: "/nonexistent" });
  const id = await storage.append("192.0.2.1", { message: "crash", bootNonce: 42 });
  await storage.updateCrashDecode(id, "old decode", {
    rawDump: "saved register dump\nsaved stack", gitVersion: "V2.0.0-3-develop", smingVersion: "sming-release-tag",
    soc: "esp8266", buildType: "release",
  });
  const decoder = Object.create(CrashDecoder.prototype);
  Object.assign(decoder, { storage, db, _decodeQueue: Promise.resolve(), elfCacheDir: "/cache", elfBaseUrl: "http://example.test" });
  decoder._ensureElf = async url => { assert.match(url, /V2\.0\.0-3-develop\/esp8266\/release\/app_0.out$/); };
  decoder._ensureScript = async () => {};
  decoder._getSourceRepos = async (firmwareVersion, smingVersion) => {
    assert.equal(firmwareVersion, "V2.0.0-3-develop");
    assert.equal(smingVersion, "sming-release-tag");
    return {};
  };
  decoder._decodeWithContext = async (cfg, elfPath, lines) => {
    assert.deepEqual(lines, ["saved register dump", "saved stack"]);
    return { decoded: "corrected decode", codeSnippets: [] };
  };

  assert.equal(await decoder.rerunRecord(id), "corrected decode");
  assert.equal(storage.getCrashRecord(id).crashDecode, "corrected decode");
  assert.equal(storage.getCrashRecord(id).smingVersion, "sming-release-tag");
});

test("automatic decoding selects metadata for the crash boot, not the controller's current boot", async context => {
  const db = openDatabase(":memory:");
  context.after(() => db.close());
  const storage = new LogStorage({ db, dataDir: "/nonexistent" });
  const id = await storage.append("192.0.2.1", { message: "crash", boot: 1, bootNonce: 111, gitVersion: "new-firmware", soc: "esp8266" });
  await storage.updateCrashDecode(id, "pending", { rawDump: "old boot stack", gitVersion: "new-firmware", soc: "esp8266" });
  db.prepare(`INSERT INTO controller_boot_info
    (ip, boot, boot_nonce, soc, build_type, git_version, sming_version, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run("192.0.2.1", 1, 111, "esp8266", "debug", "old-firmware", "old-sming", new Date().toISOString());
  db.prepare(`INSERT INTO controller_boot_info
    (ip, boot, boot_nonce, soc, build_type, git_version, sming_version, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run("192.0.2.1", 2, 222, "esp8266", "debug", "new-firmware", "new-sming", new Date().toISOString());

  const decoder = Object.create(CrashDecoder.prototype);
  Object.assign(decoder, {
    storage, db, aiEnabled: false, elfCacheDir: "/cache", elfBaseUrl: "http://example.test",
    discovery: { controllers: new Map([["192.0.2.1", { gitVersion: "new-firmware", smingVersion: "new-sming", soc: "esp8266" }]]), bootNumbers: new Map([["192.0.2.1", 2]]) },
  });
  decoder._ensureElf = async url => { assert.match(url, /old-firmware\/esp8266\/debug\/app_0.out$/); };
  decoder._ensureScript = async () => {};
  decoder._getSourceRepos = async (gitVersion, smingVersion) => {
    assert.equal(gitVersion, "old-firmware");
    assert.equal(smingVersion, "old-sming");
    return {};
  };
  decoder._decodeWithContext = async () => ({ decoded: "decoded old boot", codeSnippets: [] });

  await decoder._decodeRecord("192.0.2.1", id, {
    id, sourceIp: "192.0.2.1", boot: 1, bootNonce: 111,
    gitVersion: "new-firmware", soc: "esp8266", buildType: "debug",
  }, ["old boot stack"]);
  assert.equal(storage.getCrashRecord(id).gitVersion, "old-firmware");
  assert.equal(storage.getCrashRecord(id).smingVersion, "old-sming");
});

test("failed decoder rerun returns the failure and saved raw stack together", async context => {
  const db = openDatabase(":memory:");
  context.after(() => db.close());
  const storage = new LogStorage({ db, dataDir: "/nonexistent" });
  const id = await storage.append("192.0.2.1", { message: "crash", boot: 1 });
  await storage.updateCrashDecode(id, "old decode", {
    rawDump: "pc=0x40201000\nStack dump:\n3ffff000: 40201000", gitVersion: "V1.0.0-1-develop",
    soc: "esp8266", buildType: "debug",
  });
  const decoder = Object.create(CrashDecoder.prototype);
  Object.assign(decoder, { storage, db, _decodeQueue: Promise.resolve(), elfCacheDir: "/cache", elfBaseUrl: "http://example.test" });
  decoder._ensureElf = async () => { throw new Error("ELF download unavailable"); };

  const result = await decoder.rerunRecord(id);
  assert.match(result, /Crash decode error: ELF download unavailable/);
  assert.match(result, /Raw stack dump:\npc=0x40201000\nStack dump:/);
  assert.equal(storage.getCrashRecord(id).crashDecode, result);
});

test("automatic decoder asset failure stores its message with the captured stack", async context => {
  const db = openDatabase(":memory:");
  context.after(() => db.close());
  const storage = new LogStorage({ db, dataDir: "/nonexistent" });
  const id = await storage.append("192.0.2.1", { message: "panic", boot: 1, bootNonce: 111 });
  const decoder = Object.create(CrashDecoder.prototype);
  Object.assign(decoder, { storage, db, aiEnabled: false, elfCacheDir: "/cache", elfBaseUrl: "http://example.test" });
  decoder._ensureElf = async () => { throw new Error("ELF download unavailable"); };

  await decoder._decodeRecord("192.0.2.1", id, {
    id, sourceIp: "192.0.2.1", boot: 1, bootNonce: 111, gitVersion: "V1.0.0-1-develop", soc: "esp8266", buildType: "debug",
  }, ["pc=0x40201000", "Stack dump:", "3ffff000: 40201000"]);

  const decode = storage.getCrashRecord(id).crashDecode;
  assert.match(decode, /Crash decode error: failed downloading ELF: ELF download unavailable/);
  assert.match(decode, /Raw stack dump:\npc=0x40201000\nStack dump:\n3ffff000: 40201000/);
});

test("map cache isolates firmware, SoC, and build type and selects architecture filenames", async context => {
  const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "crash-maps-"));
  context.after(() => fs.rm(cacheDir, { recursive: true, force: true }));
  const harvester = new AIContextHarvester({ cacheDir, elfBaseUrl: "http://example.test" });
  const requests = [];
  harvester.downloadUrl = async url => { requests.push(url); return `symbols:${url}`; };
  const builds = [
    ["V1.0.0-1-develop", "esp8266", "debug"], ["V2.0.0-1-develop", "esp8266", "debug"],
    ["V1.0.0-1-develop", "esp32", "debug"], ["V1.0.0-1-develop", "esp32", "release"],
    ["V1.0.0-1-develop", "esp32c3", "debug"],
  ];
  const symbols = await Promise.all(builds.map(build => harvester.fetchMapFile(...build)));
  assert.equal(new Set(symbols).size, builds.length);
  assert.equal(requests.length, builds.length);
  assert.ok(requests[0].endsWith("/esp8266/debug/app_0.map"));
  assert.ok(requests.some(url => url.endsWith("/esp32/debug/app.map")));
  assert.equal(await harvester.fetchMapFile(...builds[0]), symbols[0]);
  assert.equal(requests.length, builds.length);
});

test("automatic AI opt-out skips generation and decoded assembly reaches the final-only workflow", async () => {
  const decoder = Object.create(CrashDecoder.prototype);
  decoder.aiEnabled = false;
  decoder.elfBaseUrl = "http://example.test";
  decoder.elfCacheDir = "/cache";
  decoder._resolveTargetInfo = async () => ({ git_version: "version", soc: "esp8266" });
  decoder._ensureElf = async () => {};
  decoder._ensureScript = async () => {};
  decoder._getSourceRepos = async () => ({});
  decoder._decodeWithContext = async () => ({ decoded: "Disassembly around 0x40201000:\n40201000: l32i a2, a3, 0\n", codeSnippets: [] });
  decoder.harvester = { fetchMapFile: async () => "map" };
  let calls = 0;
  decoder.aiService = { isAvailable: () => true, analyzeCrash: async evidence => {
    calls++;
    assert.match(evidence.disassembly, /l32i/);
    return "final report";
  } };
  let result;
  decoder.onDecoded = record => { result = record; };
  await decoder._decodeRecord("192.0.2.1", 1, {}, []);
  assert.equal(calls, 0);
  decoder.aiEnabled = true;
  await decoder._decodeRecord("192.0.2.1", 2, {}, []);
  assert.equal(calls, 1);
  assert.match(result.crashDecode, /--- AI Analysis ---\n\nfinal report/);
  assert.ok(!result.crashDecode.includes("AI Pass 1"));
});

test("source range requests honor ranges, full-file expansion, and UTF-8 budgets", async context => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "crash-ranges-"));
  context.after(() => fs.rm(temp, { recursive: true, force: true }));
  await fs.writeFile(path.join(temp, "sample.cpp"), "first\nsecond\nthird\nfourth");
  const harvester = new AIContextHarvester({ cacheDir: temp });
  const ranges = await harvester.getContextFiles([{ file: "sample.cpp", start_line: 2, end_line: 3 }], { app: temp });
  assert.equal(ranges[0].snippet, "2:second\n3:third");
  assert.equal(ranges[0].startLine, 2);
  const full = await harvester.getContextFiles([{ file: "sample.cpp", full_file: true }], { app: temp });
  assert.equal(full[0].stopLine, 4);
  assert.equal((await harvester.getContextFiles([{ file: "sample.cpp", full_file: true }], { app: temp }, { maxBytes: 2 })).length, 0);
});