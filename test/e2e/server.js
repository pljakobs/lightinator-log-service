// Shared helper: start src/index.js on random ports with a temp data dir.
const { spawn } = require("child_process");
const dgram = require("dgram");
const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

async function waitFor(url, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Server did not become ready: ${lastErr?.message || "timeout"}`);
}

async function startServer() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lls-e2e-"));
  const httpPort = await freePort();
  const udpPort = await freePort();
  const env = {
    ...process.env,
    LLS_HTTP_HOST: "127.0.0.1",
    LLS_UDP_HOST: "127.0.0.1",
    LLS_HTTP_PORT: String(httpPort),
    LLS_UDP_PORT: String(udpPort),
    LLS_DATA_DIR: path.join(tmpDir, "logs"),
    LLS_DB_PATH: path.join(tmpDir, "db.sqlite"),
    LLS_LOKI_CONFIG: path.join(tmpDir, "loki.json"),
    LLS_CONTROLLER_STATE: path.join(tmpDir, "controllers.json"),
    LLS_SERVICE_ENV: path.join(tmpDir, "service.env"),
    LLS_ELF_CACHE_DIR: path.join(tmpDir, "elfs"),
    LLS_DISCOVERY_SEEDS: "",
    LLS_MDNS_HOST: "lls-test.local",
  };
  const proc = spawn(process.execPath, [path.join(__dirname, "..", "..", "src", "index.js")], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  proc.stdout.on("data", (d) => { output += d; });
  proc.stderr.on("data", (d) => { output += d; });

  const baseUrl = `http://127.0.0.1:${httpPort}`;
  try {
    await waitFor(`${baseUrl}/health`);
  } catch (e) {
    proc.kill();
    throw new Error(`${e.message}\n--- server output ---\n${output}`);
  }

  async function sendSyslog(lines) {
    const sock = dgram.createSocket("udp4");
    for (const line of lines) {
      await new Promise((res, rej) => sock.send(line, udpPort, "127.0.0.1", (err) => (err ? rej(err) : res())));
      await new Promise((r) => setTimeout(r, 5));
    }
    sock.close();
    // give the server a moment to persist
    await new Promise((r) => setTimeout(r, 300));
  }

  async function stop() {
    proc.kill("SIGTERM");
    await new Promise((r) => {
      const t = setTimeout(() => { proc.kill("SIGKILL"); r(); }, 3000);
      proc.on("exit", () => { clearTimeout(t); r(); });
    });
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  return { baseUrl, httpPort, udpPort, sendSyslog, stop, getOutput: () => output };
}

/** Lines for `perBoot` messages in each of the given boot nonces (new-firmware format). */
function bootLines(nonces, perBoot = 5) {
  const lines = [];
  for (const nonce of nonces) {
    for (let i = 0; i < perBoot; i++) {
      lines.push(`<14>lightinator app: nonce:${nonce} ${1000 + i * 100} nonce ${nonce} message ${i}`);
    }
  }
  return lines;
}

module.exports = { startServer, bootLines };
