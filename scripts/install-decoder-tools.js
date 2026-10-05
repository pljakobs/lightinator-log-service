"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { Readable, Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const execFileAsync = promisify(execFile);
const manifest = require("../config/decoder-toolchains.json");

function getToolchainDownloads(architecture) {
  const host = architecture === "x64" ? "amd64" : architecture;
  if (!["amd64", "arm64"].includes(host)) throw new Error("Unsupported decoder host architecture");
  return Object.entries(manifest).map(([prefix, downloads]) => ({ prefix, ...downloads[host] }));
}

async function install(output, architecture) {
  const temp = await fsp.mkdtemp(path.join(os.tmpdir(), "decoder-tools-"));
  try {
    await fsp.mkdir(path.join(output, "bin"), { recursive: true });
    await fsp.mkdir(path.join(output, "tools"), { recursive: true });
    for (const download of getToolchainDownloads(architecture)) {
      const archive = path.join(temp, `${download.prefix}.tar.xz`);
      const response = await fetch(download.url);
      if (!response.ok) throw new Error(`Toolchain download failed: HTTP ${response.status}`);
      const hash = createHash("sha256");
      await pipeline(Readable.fromWeb(response.body), new Transform({
        transform(chunk, encoding, callback) { hash.update(chunk); callback(null, chunk); },
      }), fs.createWriteStream(archive));
      if (hash.digest("hex") !== download.sha256) throw new Error("Toolchain checksum mismatch");
      await execFileAsync("tar", ["-xJf", archive, "-C", temp]);
      const target = download.prefix === "xtensa-esp-elf" ? "xtensa-esp32-elf" : download.prefix;
      for (const tool of ["addr2line", "nm", "objdump", "as", "ld"]) {
        const source = path.join(temp, download.prefix, "bin", `${download.prefix}-${tool}`);
        const destination = path.join(output, "bin", `${target}-${tool}`);
        await fsp.copyFile(source, destination);
        await fsp.chmod(destination, 0o755);
        await execFileAsync(destination, ["--version"]);
      }
    }
    for (const name of ["esp8266", "esp32"]) {
      const source = path.join(__dirname, "..", "tools", `decode-${name}.py`);
      const destination = path.join(output, "tools", `decode-${name}.py`);
      await fsp.copyFile(source, destination);
      await fsp.chmod(destination, 0o755);
    }
  } finally {
    await fsp.rm(temp, { recursive: true, force: true });
  }
}

if (require.main === module) {
  install(path.resolve(process.argv[2] || "/extract"), process.argv[3] || process.arch)
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}

module.exports = { getToolchainDownloads };