import { BASE, fetchJson, escHtml, fmtLogTime, currentTab } from './common.js';
import { selectSource, fetchLogs } from './logs.js';
import { handleCrashBtnClick } from './crash.js';

const listEl    = document.getElementById('crashes-list');
const statusEl  = document.getElementById('crashes-status');
const refreshEl = document.getElementById('crashes-refresh-btn');
const ipSelEl   = document.getElementById('crashes-ip-sel');

const REFRESH_MS = 15000;
let items = [];
let timer = null;

function fmtDateTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const date = d.toLocaleDateString('en-CA'); // YYYY-MM-DD
  return `${date} ${fmtLogTime(iso)}`;
}

async function loadIpOptions() {
  try {
    const { items: sources } = await fetchJson(`${BASE}/api/v1/sources`);
    const current = ipSelEl.value;
    const opts = ['<option value="">All</option>'];
    for (const s of sources) {
      opts.push(`<option value="${escHtml(s.ip)}">${escHtml(s.ip)}</option>`);
    }
    ipSelEl.innerHTML = opts.join('');
    if (sources.some(s => s.ip === current)) ipSelEl.value = current;
  } catch { /* keep existing options */ }
}

async function loadCrashes() {
  statusEl.textContent = 'Loading…';
  try {
    let url = `${BASE}/api/v1/crashes?limit=200`;
    const ip = ipSelEl.value;
    if (ip) url += `&ip=${encodeURIComponent(ip)}`;
    const data = await fetchJson(url);
    items = data.items || [];
    render();
    statusEl.textContent = data.total === 0
      ? 'No crashes recorded'
      : `${items.length} of ${data.total} crash${data.total !== 1 ? 'es' : ''}`;
  } catch (e) {
    statusEl.textContent = 'Error: ' + e.message;
    listEl.innerHTML = `<div class="empty">Error: ${escHtml(e.message)}</div>`;
  }
}

function render() {
  if (!items.length) {
    listEl.innerHTML = '<div class="empty">No crashes recorded</div>';
    return;
  }
  const parts = [
    '<div class="crash-hdr"><span>Time</span><span>Controller</span><span>Boot</span><span>Crash</span><span></span></div>',
  ];
  for (const c of items) {
    const boot = c.boot != null ? `&#x21bb; ${c.boot}` : '';
    const fp = c.fingerprint ? `<span class="crash-fp" title="Fingerprint">${escHtml(c.fingerprint.slice(0, 12))}</span>` : '';
    const pending = c.pending ? '<span class="crash-pending">&#x23F3; decoding…</span>' : '';
    const text = c.summary ? escHtml(c.summary) : `<span class="crash-msg">${escHtml(c.message || '')}</span>`;
    const issue = c.issueUrl
      ? `<a href="${escHtml(c.issueUrl)}" target="_blank" rel="noopener" title="Open GitHub issue">#${escHtml(c.issueNumber ?? '')}</a>`
      : '';
    const meta = [c.soc, c.gitVersion].filter(Boolean).map(escHtml).join(' · ');
    parts.push(
      `<div class="crash-row" data-id="${c.id}" data-ip="${escHtml(c.ip)}" title="${escHtml(c.pending ? 'Crash decode in progress…' : 'Click to view decoded stack trace')}${meta ? '\n' + meta : ''}">` +
        `<span class="col-time">${fmtDateTime(c.receivedAt)}</span>` +
        `<span class="col-ip">${escHtml(c.ip)}</span>` +
        `<span class="col-boot">${boot}</span>` +
        `<span class="col-summary">${pending}${fp}${text}</span>` +
        `<span class="col-actions">${issue}<button class="crash-view-log" data-id="${c.id}" data-ip="${escHtml(c.ip)}" title="Show this crash in the log view">View in log</button></span>` +
      `</div>`,
    );
  }
  listEl.innerHTML = parts.join('');
}

listEl.addEventListener('click', async (e) => {
  const viewBtn = e.target.closest('.crash-view-log');
  if (viewBtn) {
    e.stopPropagation();
    const id = Number(viewBtn.dataset.id);
    await selectSource(viewBtn.dataset.ip);
    await fetchLogs({ from: id, mode: 'jump' });
    return;
  }
  if (e.target.closest('a')) return;
  const row = e.target.closest('.crash-row');
  if (!row) return;
  const id = Number(row.dataset.id);
  if (id) handleCrashBtnClick(id, [], row.dataset.ip);
});

refreshEl.addEventListener('click', () => { loadIpOptions(); loadCrashes(); });
ipSelEl.addEventListener('change', loadCrashes);

function startTimer() {
  stopTimer();
  timer = setInterval(() => { if (currentTab() === 'crashes') loadCrashes(); }, REFRESH_MS);
}
function stopTimer() {
  if (timer) { clearInterval(timer); timer = null; }
}

document.addEventListener('tabchange', (e) => {
  if (e.detail === 'crashes') {
    loadIpOptions();
    loadCrashes();
    startTimer();
  } else {
    stopTimer();
  }
});

loadIpOptions();
loadCrashes();
