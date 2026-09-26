const { test } = require("node:test");
const assert = require("node:assert/strict");
const { BootTracker } = require("../src/bootTracker");

const ip = "10.0.0.1";

test("new nonce starts a new boot, same nonce keeps it", () => {
  const t = new BootTracker();
  const a = { bootNonce: 111 };
  const b = { bootNonce: 111 };
  const c = { bootNonce: 222 };
  assert.equal(t.assign(ip, a), true);
  assert.equal(t.assign(ip, b), true);
  assert.equal(t.assign(ip, c), true);
  assert.equal(a.boot, 1);
  assert.equal(b.boot, 1);
  assert.equal(c.boot, 2);
});

test("lines without nonce inherit the current boot", () => {
  const t = new BootTracker();
  t.assign(ip, { bootNonce: 111 });
  const r = {};
  t.assign(ip, r);
  assert.equal(r.boot, 1);
});

test("late packet from previous boot does not create fake reboots", () => {
  const t = new BootTracker();
  t.assign(ip, { bootNonce: 111 });
  t.assign(ip, { bootNonce: 222 });
  const late = { bootNonce: 111 };
  const cur = { bootNonce: 222 };
  t.assign(ip, late);
  t.assign(ip, cur);
  assert.equal(late.boot, 1);
  assert.equal(cur.boot, 2);
  assert.equal(t.currentBoot(ip), 2);
});

test("duplicate restart marker for known nonce is dropped", () => {
  const t = new BootTracker();
  assert.equal(t.assign(ip, { bootNonce: 5, isRestartMarker: true }), true);
  assert.equal(t.assign(ip, { bootNonce: 5, isRestartMarker: true }), false);
  assert.equal(t.assign(ip, { bootNonce: 5 }), true);
});

test("restored nonce after service restart does not increment boot", () => {
  const t = new BootTracker();
  t.restore(ip, 7, 333);
  const r = { bootNonce: 333 };
  t.assign(ip, r);
  assert.equal(r.boot, 7);
  const n = { bootNonce: 444 };
  t.assign(ip, n);
  assert.equal(n.boot, 8);
});

test("restore without nonce keeps counter only", () => {
  const t = new BootTracker();
  t.restore(ip, 3, undefined);
  const r = {};
  t.assign(ip, r);
  assert.equal(r.boot, 3);
});

test("known nonces are bounded per IP", () => {
  const t = new BootTracker({ maxKnownNonces: 2 });
  t.assign(ip, { bootNonce: 1 });
  t.assign(ip, { bootNonce: 2 });
  t.assign(ip, { bootNonce: 3 });
  assert.equal(t.nonces.get(ip).size, 2);
  assert.equal(t.nonces.get(ip).has(1), false);
});

test("IPs are tracked independently", () => {
  const t = new BootTracker();
  const a = { bootNonce: 1 };
  const b = { bootNonce: 1 };
  t.assign("10.0.0.1", a);
  t.assign("10.0.0.2", b);
  assert.equal(a.boot, 1);
  assert.equal(b.boot, 1);
});
