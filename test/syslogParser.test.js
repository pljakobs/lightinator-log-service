const { test } = require("node:test");
const assert = require("node:assert/strict");
const { parseSyslogLine } = require("../src/syslogParser");

test("parses new-firmware line with per-line nonce and device time", () => {
  const r = parseSyslogLine("<14>lightinator app: nonce:12345 4711 hello world", "10.0.0.1");
  assert.equal(r.priority, 14);
  assert.equal(r.tag, "lightinator");
  assert.equal(r.app, "app");
  assert.equal(r.bootNonce, 12345);
  assert.equal(r.deviceTime, 4711);
  assert.equal(r.message, "hello world");
  assert.equal(r.isRestartMarker, false);
});

test("parses old-firmware restart marker with embedded nonce", () => {
  const r = parseSyslogLine("<14>lightinator app: ===== system restart ===== nonce:999", "10.0.0.1");
  assert.equal(r.isRestartMarker, true);
  assert.equal(r.bootNonce, 999);
});

test("old-firmware regular line has no nonce", () => {
  const r = parseSyslogLine("<14>lightinator app: 123 booting", "10.0.0.1");
  assert.equal(r.bootNonce, undefined);
  assert.equal(r.deviceTime, 123);
  assert.equal(r.message, "booting");
});

test("unparseable line is kept as raw message", () => {
  const r = parseSyslogLine("garbage without syslog header", "10.0.0.1");
  assert.equal(r.priority, null);
  assert.equal(r.message, "garbage without syslog header");
  assert.equal(r.bootNonce, undefined);
});
