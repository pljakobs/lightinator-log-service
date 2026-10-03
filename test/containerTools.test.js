const { test } = require("node:test");
const assert = require("node:assert/strict");
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