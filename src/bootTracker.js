/**
 * Tracks per-IP boot counters from the boot nonce carried in syslog lines.
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
  }

  restore(ip, boot, nonce) {
    this.counters.set(ip, boot || 0);
    if (nonce !== undefined && nonce !== null) {
      this.nonces.set(ip, new Map([[nonce, boot || 0]]));
    }
  }

  currentBoot(ip) {
    return this.counters.get(ip) || 0;
  }

  /**
   * Assign `record.boot`. Returns false when the record is a duplicate restart
   * marker for an already-known nonce and should be dropped.
   */
  assign(ip, record) {
    const nonce = record.bootNonce;
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
        const boot = this.currentBoot(ip) + 1;
        this.counters.set(ip, boot);
        known.set(nonce, boot);
        if (known.size > this.maxKnownNonces) known.delete(known.keys().next().value);
      }
    }
    if (record.boot === undefined) record.boot = this.currentBoot(ip);
    return true;
  }
}

module.exports = { BootTracker };
