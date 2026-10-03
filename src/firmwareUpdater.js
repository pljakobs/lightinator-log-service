"use strict";

const { isIP } = require("node:net");
const { randomUUID } = require("node:crypto");
const { setTimeout: delay } = require("node:timers/promises");

function updateError(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function branchFromVersion(version) {
  const parts = String(version || "").split("-");
  return parts.length >= 3 ? parts.slice(2).join("-") : "";
}

function httpUrl(value, base) {
  let url;
  try { url = new URL(value, base); } catch { throw updateError("Invalid firmware URL"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw updateError("Firmware URLs must use HTTP(S) without embedded credentials");
  return url;
}

class FirmwareUpdater {
  constructor({ apiUrl = "https://lightinator.de/api", getController, controllerPort = 80, enabled = false,
    fetchImpl = fetch, pollMs = 2000, timeoutMs = 300000 } = {}) {
    this.apiUrl = httpUrl(apiUrl).href.replace(/\/$/, "");
    this.getController = getController;
    this.controllerPort = controllerPort;
    this.enabled = enabled;
    this.fetch = fetchImpl;
    this.pollMs = pollMs;
    this.timeoutMs = timeoutMs;
    this.jobs = new Map();
    this.active = new Map();
    this.abort = new AbortController();
  }

  _controller(ip) {
    if (isIP(ip) !== 4 || !this.getController?.(ip)) throw updateError("Controller not found", 404);
    return `http://${ip}:${this.controllerPort}`;
  }

  async _json(url, options = {}) {
    let response;
    try {
      response = await this.fetch(url, { ...options, redirect: "error",
        signal: AbortSignal.any([AbortSignal.timeout(8000), this.abort.signal]) });
    } catch { throw updateError("Firmware service request failed", 502); }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw updateError(response.status === 401 ? "Controller OTA authentication failed" : `Firmware request returned HTTP ${response.status}`, response.status === 401 ? 401 : response.status === 409 ? 409 : 502);
    }
    const reader = response.body?.getReader();
    if (!reader) throw updateError("Firmware service returned an empty response", 502);
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 1048576) throw updateError("Firmware response exceeds the size limit", 502);
        chunks.push(Buffer.from(value));
      }
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch (error) {
      await reader.cancel().catch(() => {});
      throw error.status ? error : updateError("Firmware service returned invalid JSON", 502);
    }
  }

  async info(ip) {
    const info = await this._json(`${this._controller(ip)}/info?v=2`);
    const soc = String(info.device?.soc || info.soc || "").toLowerCase();
    const version = info.app?.git_version || info.git_version || "";
    const type = info.app?.build_type || info.build_type || "";
    if (typeof version !== "string" || typeof type !== "string") throw updateError("Controller returned invalid firmware metadata");
    const firmwareId = info.app?.firmware_id;
    if (!["esp8266", "esp32", "esp32c3"].includes(soc) ||
        (firmwareId && !["esp_rgbww_firmware", "esp-rgbww-firmware"].includes(firmwareId))) {
      throw updateError("Controller firmware is not supported for Lightinator OTA updates");
    }
    return { soc, version, type, branch: branchFromVersion(version), deviceId: info.device?.id ?? info.device?.mac ?? null };
  }

  async catalogue(kind, filters = {}) {
    if (!["branches", "types", "versions"].includes(kind)) throw updateError("Invalid firmware catalogue request");
    const url = new URL(`${this.apiUrl}/firmware/${kind}`);
    for (const [key, value] of Object.entries(filters)) {
      if (!["soc", "branch", "type"].includes(key) || typeof value !== "string" || value.length > 200) throw updateError("Invalid firmware filter");
      if (value) url.searchParams.set(key, value);
    }
    const result = await this._json(url.href);
    if (!Array.isArray(result)) throw updateError("Unexpected firmware catalogue response", 502);
    if (kind !== "versions") return result.filter(value => typeof value === "string" && value.length <= 200);
    return result.filter(entry => entry && typeof entry.version === "string" && typeof entry.url === "string")
      .filter(entry => (!filters.soc || String(entry.soc).toLowerCase() === filters.soc.toLowerCase()) &&
        (!filters.branch || entry.branch === filters.branch) && (!filters.type || entry.type === filters.type))
      .map(entry => {
        const artifact = httpUrl(entry.url, this.apiUrl + "/");
        if (artifact.hostname !== new URL(this.apiUrl).hostname) throw updateError("Firmware artifact host does not match the configured catalogue", 502);
        return { version: entry.version, soc: String(entry.soc).toLowerCase(), branch: entry.branch, type: entry.type,
          url: artifact.href, comment: String(entry.comment || "").slice(0, 4000) };
      }).sort((first, second) => second.version.localeCompare(first.version, undefined, { numeric: true }));
  }

  async options(ip, { branch, type } = {}) {
    if (!this.enabled) throw updateError("Firmware updates are disabled in Service settings", 403);
    const current = await this.info(ip);
    const branches = await this.catalogue("branches", { soc: current.soc });
    const selectedBranch = branches.includes(branch) ? branch : branches.includes(current.branch) ? current.branch : branches[0];
    const types = selectedBranch ? await this.catalogue("types", { soc: current.soc, branch: selectedBranch }) : [];
    const selectedType = types.includes(type) ? type : types.includes(current.type) ? current.type : types[0];
    const versions = selectedType ? await this.catalogue("versions", { soc: current.soc, branch: selectedBranch, type: selectedType }) : [];
    return { current, branches, types, branch: selectedBranch || "", type: selectedType || "", versions,
      activeJob: this.active.get(ip) ? this.status(ip, this.active.get(ip)) : null };
  }

  status(ip, id) {
    this._controller(ip);
    const job = this.jobs.get(id);
    if (!job || job.ip !== ip) throw updateError("Firmware update job not found", 404);
    return { ...job };
  }

  async start(ip, { branch, type, version, password = "" } = {}) {
    if (!this.enabled) throw updateError("Firmware updates are disabled in Service settings", 403);
    this._controller(ip);
    for (const value of [branch, type, version]) if (typeof value !== "string" || !value || value.length > 200) throw updateError("Select a firmware branch, build type, and version");
    if (typeof password !== "string" || password.length > 1024 || /[\r\n\0]/.test(password)) throw updateError("Invalid OTA password");
    if (this.active.has(ip)) throw updateError("A firmware update is already running for this controller", 409);
    if (this.active.size >= 4) throw updateError("Too many firmware updates are active", 429);
    this.active.set(ip, null);
    try {
      const current = await this.info(ip);
      const versions = await this.catalogue("versions", { soc: current.soc, branch, type });
      const selected = versions.find(entry => entry.version === version);
      if (!selected) throw updateError("Selected firmware is not available for this controller");
      if (selected.version.toLowerCase() === current.version.toLowerCase() && selected.type === current.type) throw updateError("This firmware build is already installed");
      for (const [id, job] of this.jobs) if (this.jobs.size >= 50 && job.finishedAt) this.jobs.delete(id);
      const job = { id: randomUUID(), ip, version: selected.version, soc: selected.soc, type: selected.type,
        previousVersion: current.version, state: "submitting", message: "Sending firmware update request", startedAt: new Date().toISOString(), finishedAt: null };
      this.jobs.set(job.id, job);
      this.active.set(ip, job.id);
      this._run(job, current, selected, password).catch(() => {
        job.state = "failed"; job.message = "Firmware update monitoring failed"; job.finishedAt = new Date().toISOString();
        this.active.delete(ip);
      });
      return { ...job };
    } catch (error) {
      this.active.delete(ip);
      throw error;
    }
  }

  async _run(job, current, selected, password) {
    try {
      const headers = { "Content-Type": "application/json" };
      if (password) headers.Authorization = "Basic " + Buffer.from(`admin:${password}`).toString("base64");
      try {
        const result = await this._json(`${this._controller(job.ip)}/update`, { method: "POST", headers,
          body: JSON.stringify({ rom: { url: selected.url } }) });
        if (result.code != null && result.code !== 0) throw updateError("Controller rejected the firmware update", 400);
      } catch (error) {
        if ([400, 401, 409].includes(error.status)) { job.state = "failed"; job.message = error.message; return; }
        job.message = "Update acknowledgement unavailable; verifying without resending";
      } finally { password = ""; delete headers.Authorization; }
      job.state = "updating";
      const deadline = Date.now() + this.timeoutMs;
      while (Date.now() < deadline && !this.abort.signal.aborted) {
        await delay(this.pollMs, undefined, { signal: this.abort.signal });
        try {
          const status = await this._json(`${this._controller(job.ip)}/update`);
          if (status.status === 4) { job.state = "failed"; job.message = "Controller reported firmware update failure"; return; }
          job.message = ({ 0: "Waiting for firmware update", 1: "Downloading and flashing firmware", 2: "Firmware written; waiting for reboot", 3: "Verifying installed firmware", 5: "Updating firmware partition", 6: "Firmware partition written" })[status.status] || "Waiting for update progress";
        } catch { job.state = "verifying"; job.message = "Controller unavailable; waiting for reboot verification"; }
        try {
          const installed = await this.info(job.ip);
          if (current.deviceId != null && installed.deviceId != null && current.deviceId !== installed.deviceId) {
            job.state = "failed"; job.message = "Device identity changed during firmware verification"; return;
          }
          if (installed.version.toLowerCase() === selected.version.toLowerCase() && installed.soc === selected.soc && installed.type === selected.type) {
            job.state = "succeeded"; job.message = `Verified installed firmware ${installed.version}`;
            const controller = this.getController(job.ip);
            if (controller) Object.assign(controller, { gitVersion: installed.version, soc: installed.soc, buildType: installed.type, reachable: true, lastSeen: new Date().toISOString() });
            return;
          }
        } catch {}
      }
      job.state = "unverified"; job.message = "Update sent, but the selected firmware could not be verified";
    } finally {
      job.finishedAt = new Date().toISOString();
      this.active.delete(job.ip);
    }
  }

  stop() { this.abort.abort(); }
}

module.exports = { FirmwareUpdater, branchFromVersion };