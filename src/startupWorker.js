"use strict";

const { Worker, isMainThread, parentPort, workerData } = require("node:worker_threads");

function initializeServiceData(options) {
  if (options.dbPath === ":memory:") return Promise.reject(new Error("Background startup requires a file-backed database"));
  return new Promise((resolve, reject) => {
    const worker = new Worker(__filename, { workerData: options });
    let received = false;
    worker.once("message", result => {
      received = true;
      if (result.error) reject(new Error(result.error));
      else resolve(result.state);
    });
    worker.once("error", reject);
    worker.once("exit", code => {
      if (!received) reject(new Error(`Startup worker exited without results (${code})`));
    });
  });
}

async function initialize(options) {
  const { openDatabase } = require("./db");
  const { LogStorage } = require("./storage");
  const { ControllerDiscovery } = require("./discovery");
  const db = openDatabase(options.dbPath);
  try {
    const storage = new LogStorage({ db, dataDir: options.dataDir, maxRowsPerIp: options.maxRowsPerIp,
      retentionDays: options.retentionDays, maxBytesPerIp: options.maxBytesPerIp });
    await storage.init();
    storage.prune();
    const discovery = new ControllerDiscovery({ db, statePath: options.controllerStatePath, seedHosts: [], refreshIntervalMs: 0 });
    await discovery._loadState();
    const boots = [];
    for (const source of storage.listSources()) {
      const boot = await storage.lastBootFor(source.ip);
      const state = { ip: source.ip, boot, nonce: storage.lastBootNonceFor(source.ip, boot) };
      const deviceTime = storage.lastDeviceTimeFor(source.ip, boot);
      if (deviceTime != null) state.deviceTime = deviceTime;
      boots.push(state);
    }
    return { boots, controllers: discovery.getAll() };
  } finally {
    db.close();
  }
}

if (!isMainThread) {
  initialize(workerData)
    .then(state => parentPort.postMessage({ state }))
    .catch(error => parentPort.postMessage({ error: error.message }))
    .finally(() => parentPort.close());
}

module.exports = { initializeServiceData };