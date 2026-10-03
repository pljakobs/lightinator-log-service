import { BASE, fetchJson } from './common.js';

const overlay = document.getElementById('firmware-overlay');
const statusEl = document.getElementById('firmware-status');
const branchEl = document.getElementById('firmware-branch');
const typeEl = document.getElementById('firmware-type');
const versionEl = document.getElementById('firmware-version');
const passwordEl = document.getElementById('firmware-password');
const startBtn = document.getElementById('firmware-start');
const jobs = new Map();
let currentIp = null;
let options = null;
let generation = 0;
let returnFocus = null;
const terminal = state => ['succeeded', 'failed', 'unverified'].includes(state);

function endpoint(ip) { return `${BASE}/api/v1/controllers/${encodeURIComponent(ip)}/firmware`; }

function updateButtons(ip) {
  const job = jobs.get(ip);
  document.querySelectorAll('.ctrl-update-btn').forEach(button => {
    if (button.dataset.ip !== ip) return;
    button.disabled = button.dataset.available !== 'true' || (job && !terminal(job.state));
    button.textContent = job && !terminal(job.state) ? 'Updating…' : 'Update firmware';
  });
}

function setChoices(select, entries, selected) {
  select.replaceChildren(...entries.map(entry => new Option(entry, entry)));
  if (entries.includes(selected)) select.value = selected;
}

function renderSelection() {
  const selected = options?.versions.find(entry => entry.version === versionEl.value);
  document.getElementById('firmware-comment').textContent = selected?.comment || '';
  document.getElementById('firmware-target').textContent = selected ? `${selected.version} · ${selected.soc} · ${selected.branch} · ${selected.type}` : 'No compatible firmware available';
  const alreadyInstalled = selected && selected.version.toLowerCase() === options.current.version.toLowerCase() && selected.type === options.current.type;
  startBtn.disabled = !selected || alreadyInstalled;
  document.getElementById('firmware-confirm').hidden = true;
}

async function loadOptions() {
  const request = ++generation;
  const ip = currentIp;
  startBtn.disabled = true;
  branchEl.disabled = typeEl.disabled = versionEl.disabled = true;
  statusEl.textContent = 'Loading firmware catalogue…';
  try {
    const query = new URLSearchParams({ branch: branchEl.value, type: typeEl.value });
    const result = await fetchJson(`${endpoint(ip)}?${query}`);
    if (request !== generation || ip !== currentIp) return;
    options = result;
    document.getElementById('firmware-current').textContent = `${result.current.version || 'Unknown version'} · ${result.current.soc} · ${result.current.type || 'Unknown build type'}`;
    setChoices(branchEl, result.branches, result.branch);
    setChoices(typeEl, result.types, result.type);
    setChoices(versionEl, result.versions.map(entry => entry.version), result.versions[0]?.version);
    branchEl.disabled = !result.branches.length;
    typeEl.disabled = !result.types.length;
    versionEl.disabled = !result.versions.length;
    document.getElementById('firmware-selection').hidden = false;
    renderSelection();
    statusEl.textContent = result.versions.length ? '' : 'No compatible firmware available';
    if (result.activeJob) { jobs.set(ip, result.activeJob); showJob(result.activeJob); pollJob(ip, result.activeJob.id); }
  } catch (error) {
    if (request === generation) statusEl.textContent = error.message;
  }
}

function showJob(job) {
  updateButtons(job.ip);
  if (job.ip !== currentIp) return;
  document.getElementById('firmware-selection').hidden = true;
  document.getElementById('firmware-confirm').hidden = true;
  startBtn.hidden = true;
  const progress = document.getElementById('firmware-progress');
  progress.hidden = false;
  progress.textContent = job.state === 'succeeded' ? `Installed ${job.version}` : job.state === 'failed' ? 'Update failed' : job.state === 'unverified' ? 'Installation not verified' : 'Firmware update in progress';
  progress.dataset.state = job.state;
  statusEl.textContent = job.message;
  passwordEl.value = '';
}

const polling = new Set();
function pollJob(ip, id) {
  if (polling.has(id)) return;
  polling.add(id);
  let failures = 0;
  const poll = async () => {
    try {
      const response = await fetch(`${endpoint(ip)}/${encodeURIComponent(id)}`);
      if (response.status === 404) {
        const job = { ...jobs.get(ip), ip, state: 'unverified', message: 'Update status expired; check the controller firmware before retrying' };
        jobs.set(ip, job); showJob(job); polling.delete(id);
        return;
      }
      if (!response.ok) throw new Error('Update status request failed');
      const job = await response.json();
      failures = 0;
      jobs.set(ip, job);
      showJob(job);
      if (terminal(job.state)) {
        polling.delete(id);
        document.dispatchEvent(new CustomEvent('firmwareupdated', { detail: ip }));
        return;
      }
    } catch {
      failures++;
      if (failures >= 10) {
        const job = { ...jobs.get(ip), ip, state: 'unverified', message: 'Monitoring connection lost; update completion is unknown' };
        jobs.set(ip, job); showJob(job); polling.delete(id);
        return;
      }
      if (currentIp === ip) statusEl.textContent = 'Status unavailable; reconnecting…';
    }
    setTimeout(poll, 2000);
  };
  poll();
}

export function openFirmwareUpdate(ip, name = ip) {
  returnFocus = document.activeElement;
  currentIp = ip;
  options = null;
  passwordEl.value = '';
  branchEl.replaceChildren(); typeEl.replaceChildren(); versionEl.replaceChildren();
  document.getElementById('firmware-title').textContent = `Update ${name}`;
  document.getElementById('firmware-device').textContent = ip;
  document.getElementById('firmware-current').textContent = '';
  document.getElementById('firmware-comment').textContent = '';
  document.getElementById('firmware-target').textContent = '';
  document.getElementById('firmware-progress').hidden = true;
  document.getElementById('firmware-confirm').hidden = true;
  startBtn.hidden = false;
  overlay.classList.add('open');
  document.getElementById('firmware-close').focus();
  const job = jobs.get(ip);
  if (job && !terminal(job.state)) { showJob(job); pollJob(ip, job.id); }
  else loadOptions();
}

function close() {
  generation++;
  currentIp = null;
  passwordEl.value = '';
  overlay.classList.remove('open');
  if (returnFocus?.isConnected) returnFocus.focus();
}

document.getElementById('firmware-close').addEventListener('click', close);
overlay.addEventListener('click', event => { if (event.target === overlay) close(); });
document.addEventListener('keydown', event => { if (event.key === 'Escape' && overlay.classList.contains('open')) close(); });
overlay.addEventListener('keydown', event => {
  if (event.key !== 'Tab') return;
  const controls = [...overlay.querySelectorAll('button, select, input')].filter(element => !element.disabled && element.getClientRects().length);
  const first = controls[0];
  const last = controls[controls.length - 1];
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
});
branchEl.addEventListener('change', () => { typeEl.replaceChildren(); loadOptions(); });
typeEl.addEventListener('change', loadOptions);
versionEl.addEventListener('change', renderSelection);
startBtn.addEventListener('click', () => {
  document.getElementById('firmware-confirm-text').textContent = `Install ${versionEl.value} (${branchEl.value}/${typeEl.value}) on ${currentIp}?`;
  document.getElementById('firmware-confirm').hidden = false;
});
document.getElementById('firmware-cancel-confirm').addEventListener('click', () => { document.getElementById('firmware-confirm').hidden = true; });
document.getElementById('firmware-install').addEventListener('click', async () => {
  const ip = currentIp;
  const button = document.getElementById('firmware-install');
  button.disabled = true;
  statusEl.textContent = 'Starting firmware update…';
  const body = { branch: branchEl.value, type: typeEl.value, version: versionEl.value, password: passwordEl.value };
  passwordEl.value = '';
  try {
    const job = await fetchJson(endpoint(ip), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    jobs.set(ip, job); showJob(job); pollJob(ip, job.id);
  } catch (error) { if (currentIp === ip) statusEl.textContent = error.message; }
  finally { delete body.password; button.disabled = false; }
});

document.addEventListener('controllersrendered', () => { for (const ip of jobs.keys()) updateButtons(ip); });