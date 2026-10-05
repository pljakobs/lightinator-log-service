/**
 * Tracks per-IP boot counters from syslog boot nonces and uptime regressions.
 *
 * A boot nonce is a per-boot identifier sent by the firmware (per line on new
 * firmware, only in the "system restart" marker on old firmware). A nonce seen
 * for the first time starts a new boot; nonces seen recently map back to their
 * existing boot so late/reordered UDP packets or a service restart don't count
 * as reboots.
 */
class BootTracker {
  constructor({ maxKnownNonces = 8 } = {}) {
    this.maxKnownNonces = maxKnownNonces;
    this.counters = new Map(); // ip -> last boot number
    this.nonces = new Map();   // ip -> Map<nonce, boot>
    this.activeNonces = new Map();
    this.deviceTimes = new Map();
  }

  restore(ip, boot, nonce, deviceTime) {
    this.counters.set(ip, boot || 0);
    if (nonce !== undefined && nonce !== null) {
      this.nonces.set(ip, new Map([[nonce, boot || 0]]));
      this.activeNonces.set(ip, nonce);
    }
    if (deviceTime != null) this.deviceTimes.set(ip, { value: deviceTime });
  }

  currentBoot(ip) {
    return this.counters.get(ip) || 0;
  }

  currentNonce(ip) {
    return this.activeNonces.get(ip);
  }

  _uptimeRegressed(ip, record) {
    if (!Number.isFinite(record.deviceTime)) return false;
    const previous = this.deviceTimes.get(ip);
    if (!previous || record.deviceTime >= previous.value) return false;
    const backwardsBy = previous.value - record.deviceTime;
    const tolerance = Math.max(1000, Math.min(5000, previous.value * 0.25));
    return backwardsBy > tolerance;
  }

  /**
   * Assign `record.boot`. Returns false when the record is a duplicate restart
   * marker for an already-known nonce and should be dropped.
   */
  assign(ip, record) {
    const nonce = record.bootNonce;
    const previousBoot = this.currentBoot(ip);
    const uptimeRegressed = this._uptimeRegressed(ip, record);
    let newBoot = false;

    if (nonce !== undefined && nonce !== null) {
      let known = this.nonces.get(ip);
      if (!known) {
        known = new Map();
        this.nonces.set(ip, known);
      }
      if (known.has(nonce)) {
        const nonceBoot = known.get(nonce);
        if (record.isRestartMarker && !uptimeRegressed) return false;
        if (uptimeRegressed && nonceBoot === previousBoot) {
          record.boot = previousBoot + 1;
          this.counters.set(ip, record.boot);
          known.set(nonce, record.boot);
          this.activeNonces.set(ip, nonce);
          record.uptimeReset = true;
          newBoot = true;
        } else {
          record.boot = nonceBoot;
        }
      } else {
        record.boot = previousBoot + 1;
        this.counters.set(ip, record.boot);
        known.set(nonce, record.boot);
        this.activeNonces.set(ip, nonce);
        newBoot = true;
        if (known.size > this.maxKnownNonces) known.delete(known.keys().next().value);
      }
    } else if (uptimeRegressed) {
      record.boot = previousBoot + 1;
      this.counters.set(ip, record.boot);
      this.activeNonces.delete(ip);
      record.uptimeReset = true;
      newBoot = true;
    }
    if (record.boot === undefined) record.boot = this.currentBoot(ip);
    if (record.bootNonce === undefined) record.bootNonce = this.currentNonce(ip);

    if (Number.isFinite(record.deviceTime) && record.boot === this.currentBoot(ip)) {
      const previous = this.deviceTimes.get(ip);
      if (newBoot || !previous || record.deviceTime > previous.value) {
        this.deviceTimes.set(ip, { value: record.deviceTime });
      }
    }
    return true;
  }
}

module.exports = { BootTracker };
