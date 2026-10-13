/**
 * Tracks per-IP boot counters from syslog boot nonces and uptime regressions.
 *
 * A boot nonce is a per-boot identifier sent by the firmware (per line on new
 * firmware, only in the "system restart" marker on old firmware). A nonce seen
 * for the first time starts a new boot; nonces seen recently map back to their
 * existing boot so late/reordered UDP packets or a service restart don't count
 * as reboots. A known nonce is authoritative: its timestamps never start a boot.
 *
 * Device timestamps are 32-bit counters that wrap (every ~71.6 min for µs).
 * Records without a nonce start a new boot on an explicit restart marker or on
 * a timestamp regression that is neither small reordering nor a rollover
 * consistent with the elapsed receive time.
 */
const TIMESTAMP_MODULUS = 2 ** 32;

class BootTracker {
  constructor({ maxKnownNonces = 8, ticksPerMs = 1000, timestampModulus = TIMESTAMP_MODULUS } = {}) {
    this.maxKnownNonces = maxKnownNonces;
    this.ticksPerMs = ticksPerMs;
    this.modulus = timestampModulus;
    this.counters = new Map(); // ip -> last boot number
    this.nonces = new Map();   // ip -> Map<nonce, boot>
    this.activeNonces = new Map();
    this.deviceTimes = new Map(); // ip -> { value: raw ticks, at: receive ms, wraps }
    this.pendingMarkers = new Set(); // ips whose last record was a nonce-less restart marker
  }

  restore(ip, boot, nonce, deviceTime, receivedAt) {
    this.counters.set(ip, boot || 0);
    if (nonce !== undefined && nonce !== null) {
      this.nonces.set(ip, new Map([[nonce, boot || 0]]));
      this.activeNonces.set(ip, nonce);
    }
    if (deviceTime != null) {
      const at = receivedAt != null ? Date.parse(receivedAt) : NaN;
      this.deviceTimes.set(ip, { value: deviceTime, at: Number.isFinite(at) ? at : null, wraps: 0 });
    }
  }

  currentBoot(ip) {
    return this.counters.get(ip) || 0;
  }

  currentNonce(ip) {
    return this.activeNonces.get(ip);
  }

  /** 'forward' | 'reorder' | 'rollover' | 'regressed' relative to the last timestamp of the current boot. */
  _classifyTimestamp(ip, record, now) {
    if (!Number.isFinite(record.deviceTime)) return "none";
    const previous = this.deviceTimes.get(ip);
    if (!previous || record.deviceTime >= previous.value) return "forward";

    const second = 1000 * this.ticksPerMs;
    const backwardsBy = previous.value - record.deviceTime;
    if (backwardsBy <= Math.max(second, Math.min(5 * second, previous.value * 0.25))) return "reorder";

    // Ticks the counter advanced if it wrapped since the previous sample.
    const wrappedBy = record.deviceTime + this.modulus - previous.value;
    if (previous.at != null && Number.isFinite(now)) {
      const elapsed = Math.max(0, now - previous.at) * this.ticksPerMs;
      const wraps = Math.max(0, Math.round((elapsed - wrappedBy) / this.modulus));
      const residual = Math.abs(elapsed - (wrappedBy + wraps * this.modulus));
      if (residual <= Math.max(5 * second, elapsed * 0.02)) return "rollover";
      return "regressed";
    }
    const window = 60 * second;
    return previous.value >= this.modulus - window && record.deviceTime <= window ? "rollover" : "regressed";
  }

  _startBoot(ip, record) {
    record.boot = this.currentBoot(ip) + 1;
    this.counters.set(ip, record.boot);
  }

  /**
   * Assign `record.boot`. Returns false when the record is a duplicate restart
   * marker and should be dropped.
   */
  assign(ip, record) {
    const nonce = record.bootNonce;
    const parsedAt = record.receivedAt != null ? Date.parse(record.receivedAt) : NaN;
    const now = Number.isFinite(parsedAt) ? parsedAt : Date.now();
    const timestamp = this._classifyTimestamp(ip, record, now);
    const pendingMarker = this.pendingMarkers.delete(ip);
    let newBoot = false;

    if (nonce !== undefined && nonce !== null) {
      let known = this.nonces.get(ip);
      if (!known) {
        known = new Map();
        this.nonces.set(ip, known);
      }
      if (known.has(nonce)) {
        if (record.isRestartMarker) return false;
        record.boot = known.get(nonce);
      } else {
        this._startBoot(ip, record);
        known.set(nonce, record.boot);
        this.activeNonces.set(ip, nonce);
        newBoot = true;
        if (known.size > this.maxKnownNonces) known.delete(known.keys().next().value);
      }
    } else if (record.isRestartMarker) {
      if (pendingMarker) return false;
      this._startBoot(ip, record);
      this.activeNonces.delete(ip);
      this.pendingMarkers.add(ip);
      newBoot = true;
    } else if (timestamp === "regressed") {
      this._startBoot(ip, record);
      this.activeNonces.delete(ip);
      record.uptimeReset = true;
      newBoot = true;
    }
    if (record.boot === undefined) record.boot = this.currentBoot(ip);
    if (record.bootNonce === undefined) record.bootNonce = this.currentNonce(ip);

    if (newBoot) {
      if (Number.isFinite(record.deviceTime)) this.deviceTimes.set(ip, { value: record.deviceTime, at: now, wraps: 0 });
      else this.deviceTimes.delete(ip);
    } else if (record.boot === this.currentBoot(ip) && timestamp !== "reorder" && timestamp !== "none") {
      const previous = this.deviceTimes.get(ip);
      const wraps = (previous?.wraps || 0) + (timestamp === "rollover" ? 1 : 0);
      this.deviceTimes.set(ip, { value: record.deviceTime, at: now, wraps });
    }
    return true;
  }
}

module.exports = { BootTracker, TIMESTAMP_MODULUS };
