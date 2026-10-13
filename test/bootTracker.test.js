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
  assert.equal(r.bootNonce, 111);
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

const MOD = 2 ** 32;
const SEC = 1_000_000; // device ticks are microseconds
const t0 = Date.parse("2026-01-01T00:00:00.000Z");
const at = (ms) => new Date(t0 + ms).toISOString();
const rec = (deviceTime, ms, extra = {}) => ({ deviceTime, receivedAt: at(ms), ...extra });

test("timestamp rollover with the same nonce stays in the same boot", () => {
  const t = new BootTracker();
  const before = rec(MOD - 2 * SEC, 0, { bootNonce: 1234 });
  const after = rec(1 * SEC, 3000, { bootNonce: 1234 });
  t.assign(ip, before);
  assert.equal(t.assign(ip, after), true);
  assert.equal(after.boot, before.boot);
  assert.equal(after.uptimeReset, undefined);
  assert.equal(t.deviceTimes.get(ip).value, 1 * SEC);
  assert.equal(t.deviceTimes.get(ip).wraps, 1);
});

test("same nonce never starts a boot on timestamp regression", () => {
  const t = new BootTracker();
  t.restore(ip, 4, 1234, 120 * SEC, at(0));
  const r = rec(1 * SEC, 1000, { bootNonce: 1234 });
  t.assign(ip, r);
  assert.equal(r.boot, 4);
  assert.equal(r.uptimeReset, undefined);
});

test("multiple rollovers within one run create no artificial boots", () => {
  for (const nonce of [77, undefined]) {
    const t = new BootTracker();
    const period = MOD / 1000; // ms per wrap
    let ms = 0;
    for (let tick = 0; tick < 4 * MOD; tick += 600 * SEC) {
      const r = rec(tick % MOD, ms, { bootNonce: nonce });
      t.assign(ip, r);
      assert.equal(r.boot, nonce === undefined ? 0 : 1, `nonce=${nonce} tick=${tick}`);
      ms += 600_000;
    }
    assert.ok(ms > 3 * period);
    assert.equal(t.deviceTimes.get(ip).wraps, 3);
  }
});

test("new nonce with a small timestamp is a genuine new boot", () => {
  const t = new BootTracker();
  t.assign(ip, rec(MOD - SEC, 0, { bootNonce: 1 }));
  const r = rec(0, 500, { bootNonce: 2, isRestartMarker: true });
  assert.equal(t.assign(ip, r), true);
  assert.equal(r.boot, 2);
});

test("duplicate restart marker or delayed packet from a known older nonce adds no boot", () => {
  const t = new BootTracker();
  t.assign(ip, rec(0, 0, { bootNonce: 1, isRestartMarker: true }));
  t.assign(ip, rec(50 * SEC, 50_000, { bootNonce: 1 }));
  t.assign(ip, rec(0, 60_000, { bootNonce: 2, isRestartMarker: true }));
  assert.equal(t.assign(ip, rec(0, 60_010, { bootNonce: 2, isRestartMarker: true })), false);
  assert.equal(t.assign(ip, rec(0, 60_020, { bootNonce: 1, isRestartMarker: true })), false);
  const late = rec(51 * SEC, 60_030, { bootNonce: 1 });
  t.assign(ip, late);
  assert.equal(late.boot, 1);
  assert.equal(t.currentBoot(ip), 2);
});

test("small out-of-order regression stays in the same boot", () => {
  for (const nonce of [9, undefined]) {
    const t = new BootTracker();
    t.assign(ip, rec(100 * SEC, 0, { bootNonce: nonce }));
    const r = rec(99.5 * SEC, 10, { bootNonce: nonce });
    t.assign(ip, r);
    assert.equal(r.boot, t.currentBoot(ip));
    assert.equal(r.uptimeReset, undefined);
    assert.equal(t.deviceTimes.get(ip).value, 100 * SEC);
  }
});

test("legacy timestamp rollover without a nonce is not a reboot", () => {
  const t = new BootTracker();
  t.assign(ip, rec(MOD - 10 * SEC, 0));
  const r = rec(20 * SEC, 30_000);
  t.assign(ip, r);
  assert.equal(r.boot, 0);
  assert.equal(r.uptimeReset, undefined);
  const next = rec(25 * SEC, 35_000);
  t.assign(ip, next);
  assert.equal(next.boot, 0);
});

test("legacy regression inconsistent with elapsed time is a reboot", () => {
  const t = new BootTracker();
  t.assign(ip, rec(600 * SEC, 0));
  const r = rec(2 * SEC, 10_000);
  t.assign(ip, r);
  assert.equal(r.boot, 1);
  assert.equal(r.uptimeReset, true);
});

test("explicit legacy restart marker is a genuine new boot, repeats are dropped", () => {
  const t = new BootTracker();
  t.assign(ip, rec(100 * SEC, 0));
  const marker = rec(200 * SEC, 1000, { isRestartMarker: true });
  assert.equal(t.assign(ip, marker), true);
  assert.equal(marker.boot, 1);
  assert.equal(t.assign(ip, rec(200 * SEC, 1001, { isRestartMarker: true })), false);
  t.assign(ip, rec(201 * SEC, 2000));
  const again = rec(5 * SEC, 300_000, { isRestartMarker: true });
  t.assign(ip, again);
  assert.equal(again.boot, 2);
});

test("restoration near rollover preserves continuity across a service restart", () => {
  for (const nonce of [42, undefined]) {
    const t = new BootTracker();
    t.restore(ip, 3, nonce, MOD - 5 * SEC, at(0));
    const r = rec(25 * SEC, 30_000, { bootNonce: nonce });
    t.assign(ip, r);
    assert.equal(r.boot, 3);
    assert.equal(r.uptimeReset, undefined);
  }
});

test("late old-nonce packet with low uptime does not advance the current boot", () => {
  const t = new BootTracker();
  t.assign(ip, { bootNonce: 111, deviceTime: 80_000 });
  t.assign(ip, { bootNonce: 222, deviceTime: 500 });
  const late = { bootNonce: 111, deviceTime: 1000 };
  assert.equal(t.assign(ip, late), true);
  assert.equal(late.boot, 1);
  assert.equal(t.currentBoot(ip), 2);
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
