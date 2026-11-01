const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { getToolchainDownloads } = require("../scripts/install-decoder-tools");

test("decoder toolchain downloads select native host archives and pinned checksums", () => {
  for (const [architecture, host] of [["amd64", "x86_64"], ["arm64", "aarch64"]]) {
    const downloads = getToolchainDownloads(architecture);
    assert.equal(downloads.length, 2);
    for (const download of downloads) {
      assert.match(download.url, new RegExp(`${host}-linux-gnu\\.tar\\.xz$`));
      assert.match(download.sha256, /^[0-9a-f]{64}$/);
    }
  }
  assert.throws(() => getToolchainDownloads("unsupported"), /Unsupported decoder host/);
});

test("service containers and Home Assistant packages include the log service icon", () => {
  const root = path.join(__dirname, "..");
  const asset = "images/lightinator-log-service-icon-dark.svg";
  assert.ok(fs.existsSync(path.join(root, asset)));
  for (const recipe of ["Dockerfile", "Containerfile"]) {
    assert.ok(fs.readFileSync(path.join(root, recipe), "utf8").includes(`COPY ${asset} ./${asset}`));
  }
  assert.match(fs.readFileSync(path.join(root, "src/ui/index.html"), "utf8"),
    /rel="icon"[^>]+href="\/brand\/lightinator-log-service-icon-dark\.svg"/);
  for (const [filename, size] of [
    ["custom_components/lightinator_log_service/brand/icon.png", 256],
    ["custom_components/lightinator_log_service/brand/icon@2x.png", 512],
    ["custom_components/lightinator_log_service/brand/dark_icon.png", 256],
    ["custom_components/lightinator_log_service/brand/dark_icon@2x.png", 512],
    ["lightinator_log_service/icon.png", 256],
  ]) {
    const png = fs.readFileSync(path.join(root, filename));
    assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    assert.equal(png.readUInt32BE(16), size, `${filename} width`);
    assert.equal(png.readUInt32BE(20), size, `${filename} height`);
  }
});