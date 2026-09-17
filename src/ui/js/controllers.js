import { BASE, fetchJson, escHtml, timeAgo } from './common.js';

async function loadControllers() {
  const st = document.getElementById('ctrl-status');
  st.textContent = 'Loading…';
  try {
    const data = await fetchJson(`${BASE}/api/v1/controllers`);
    renderControllerCards(data.items || []);
    st.textContent = `${(data.items||[]).length} controller(s)`;
  } catch (e) {
    st.textContent = 'Error: ' + e.message;
  }
}

function renderControllerCards(items) {
  const grid = document.getElementById('ctrl-grid');
  if (!items.length) {
    grid.innerHTML = '<div style="color:#666">No controllers discovered yet. Make sure a controller is reachable and click Refresh.</div>';
    updateRemoveSelectedBtn();
    return;
  }
  grid.innerHTML = items.map(c => {
    const groups = (c.groups||[]).map(g => g.name).join(', ') || '—';
    const deviceClass = c.deviceClass || 'swarm_controller';
    const classLabel = deviceClass === 'wall_panel' ? 'Wall Panel' : 'Swarm';
    const reachable = c.reachable !== false;
    const logOn = c.loggingEnabled !== false;
    const sb = !!c.splitBrain;
    const isDebug = !c.buildType || c.buildType === 'debug';
    const cardClass = ['ctrl-card', logOn ? '' : 'logging-off', sb ? 'split-brain' : '', isDebug ? '' : 'release-build'].filter(Boolean).join(' ');
    const buildBadge = isDebug ? '' : `<span class="release-badge" title="Release build — detailed crash decode unavailable">release</span>`;
    const toggleDisabled = !isDebug ? 'disabled title="Release build — logging not useful without debug symbols"' : '';
    const toggleBtnClass = isDebug ? 'on' : 'off';
    const displayVersion = c.gitVersion ? escHtml(c.gitVersion) : '–';
    const displayBuildType = c.buildType ? escHtml(c.buildType) : '–';
    const ip = escHtml(c.ip);
    return `<div class="${cardClass}" data-ip="${ip}">
      <div class="ctrl-name"><input type="checkbox" class="ctrl-select" data-ip="${ip}" title="Select for removal" /><a href="http://${ip}/" target="_blank" rel="noopener noreferrer" style="color:inherit;text-decoration:none" title="Open device UI">${escHtml(c.name || c.hostname || c.ip)}</a><span class="class-badge">${escHtml(classLabel)}</span>${sb ? '<span class="split-brain-badge" title="This controller is not visible to all peers">⚠ split-brain</span>' : ''}${buildBadge}<button class="ctrl-remove-btn" data-ip="${ip}" title="Remove this controller">✕ Remove</button></div>
      <div class="ctrl-ip">${ip} · ${escHtml(c.hostname||'')} · id:${escHtml(String(c.deviceId||''))}</div>
      <div class="ctrl-fw">fw: <span class="${isDebug ? 'fw-debug' : 'fw-release'}">${displayBuildType}</span> · ${displayVersion}</div>
      <div class="ctrl-groups">Groups: ${escHtml(groups)}</div>
      <div class="ctrl-actions">
        <button class="toggle-btn ${toggleBtnClass}" ${toggleDisabled} onclick="${isDebug ? `toggleLogging('${ip}',${!logOn})` : 'void 0'}">${logOn ? 'Logging ON' : 'Logging OFF'}</button>
        <span class="ctrl-status ${reachable?'ok':'unreachable'}">${reachable ? '● online' : '● offline'}</span>
        <span class="ctrl-log-received">last seen: ${timeAgo(c.lastSeen)} · last log received: ${timeAgo(c.lastLogReceived)}</span>
      </div>
    </div>`;
  }).join('');
  updateRemoveSelectedBtn();
}

function selectedIps() {
  return [...document.querySelectorAll('.ctrl-select:checked')].map(cb => cb.dataset.ip);
}

function updateRemoveSelectedBtn() {
  const btn = document.getElementById('remove-selected-btn');
  const n = selectedIps().length;
  btn.disabled = n === 0;
  btn.textContent = n ? `✕ Remove selected (${n})` : '✕ Remove selected';
}

function confirmPurge() {
  return confirm('Also delete the stored logs of the removed controller(s)?\n\nOK = delete logs too, Cancel = keep logs');
}

async function removeControllers(ips, purgeLogs) {
  const st = document.getElementById('ctrl-status');
  st.textContent = `Removing ${ips.length} controller(s)…`;
  try {
    const r = await fetch(`${BASE}/api/v1/controllers/remove`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ips, purgeLogs }),
    });
    const d = await r.json();
    await loadControllers();
    if (!r.ok) {
      st.textContent = `⚠ ${d.error || 'remove failed'}`;
    } else {
      st.textContent = `Removed ${d.removed.length} controller(s)${purgeLogs ? ' incl. logs' : ''}${d.removed.length ? ': ' + d.removed.join(', ') : ''}`;
    }
  } catch (e) {
    st.textContent = 'Error: ' + e.message;
  }
}

async function removeStale(days, purgeLogs) {
  const st = document.getElementById('ctrl-status');
  st.textContent = 'Removing stale controllers…';
  try {
    const r = await fetch(`${BASE}/api/v1/controllers/remove-stale`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ days, purgeLogs }),
    });
    const d = await r.json();
    await loadControllers();
    if (!r.ok) {
      st.textContent = `⚠ ${d.error || 'remove failed'}`;
    } else if (!d.removed.length) {
      st.textContent = `No controllers unseen for more than ${days} day(s)`;
    } else {
      st.textContent = `Removed ${d.removed.length} stale controller(s)${purgeLogs ? ' incl. logs' : ''}: ${d.removed.join(', ')}`;
    }
  } catch (e) {
    st.textContent = 'Error: ' + e.message;
  }
}

document.getElementById('ctrl-grid').addEventListener('click', (e) => {
  const btn = e.target.closest('.ctrl-remove-btn');
  if (!btn) return;
  const ip = btn.dataset.ip;
  if (!confirm(`Remove controller ${ip} from the list?`)) return;
  removeControllers([ip], confirmPurge());
});

document.getElementById('ctrl-grid').addEventListener('change', (e) => {
  if (e.target.classList.contains('ctrl-select')) updateRemoveSelectedBtn();
});

document.getElementById('remove-selected-btn').addEventListener('click', () => {
  const ips = selectedIps();
  if (!ips.length) return;
  if (!confirm(`Remove ${ips.length} selected controller(s)?\n\n${ips.join('\n')}`)) return;
  removeControllers(ips, confirmPurge());
});

document.getElementById('remove-stale-btn').addEventListener('click', () => {
  const days = Number(document.getElementById('stale-days').value);
  if (!Number.isFinite(days) || days < 0) {
    document.getElementById('ctrl-status').textContent = '⚠ days must be a non-negative number';
    return;
  }
  if (!confirm(`Remove all controllers not seen for more than ${days} day(s)?`)) return;
  removeStale(days, confirmPurge());
});

async function toggleLogging(ip, enabled) {
  const st = document.getElementById('ctrl-status');
  try {
    const r = await fetch(`${BASE}/api/v1/controllers/${encodeURIComponent(ip)}/logging`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    });
    const d = await r.json();
    await loadControllers();
    if (!r.ok) {
      st.textContent = `⚠ ${ip}: ${d.error || 'failed'}`;
    } else if (!d.firmwareUpdated && d.firmwareUpdated !== undefined) {
      st.textContent = `⚠ ${ip}: local filter updated, but firmware push skipped (set LLS_SYSLOG_ADVERTISE_HOST)`;
    } else {
      st.textContent = '';
    }
  } catch (e) {
    st.textContent = 'Error: ' + e.message;
  }
}

document.getElementById('refresh-ctrl-btn').addEventListener('click', async () => {
  const st = document.getElementById('ctrl-status');
  st.textContent = 'Refreshing…';
  try {
    const data = await fetch(`${BASE}/api/v1/controllers/refresh`, { method: 'POST' }).then(r => r.json());
    renderControllerCards(data.items || []);
    st.textContent = `${(data.items||[]).length} controller(s) — refreshed`;
  } catch (e) {
    st.textContent = 'Error: ' + e.message;
  }
});

async function setAllLogging(enabled) {
  const st = document.getElementById('ctrl-status');
  st.textContent = enabled ? 'Enabling all…' : 'Disabling all…';
  try {
    const data = await fetchJson(`${BASE}/api/v1/controllers`);
    const controllers = data.items || [];
    const results = await Promise.all(controllers.map(async c => {
      const r = await fetch(`${BASE}/api/v1/controllers/${encodeURIComponent(c.ip)}/logging`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
      return { ip: c.ip, ok: r.ok, d: await r.json() };
    }));
    await loadControllers();
    const failed = results.filter(r => !r.ok);
    const noFwPush = results.filter(r => r.ok && r.d.firmwareUpdated === false);
    if (failed.length) {
      st.textContent = `⚠ ${failed.length} controller(s) failed: ${failed.map(r=>r.ip).join(', ')}`;
    } else if (noFwPush.length) {
      st.textContent = `Local filter ${enabled?'ON':'OFF'} for all — firmware push skipped (set LLS_SYSLOG_ADVERTISE_HOST)`;
    } else {
      st.textContent = `Logging ${enabled ? 'ON' : 'OFF'} for all ${controllers.length} controller(s)`;
    }
  } catch (e) {
    st.textContent = 'Error: ' + e.message;
  }
}

document.getElementById('log-all-on-btn').addEventListener('click', () => setAllLogging(true));
document.getElementById('log-all-off-btn').addEventListener('click', () => setAllLogging(false));

document.addEventListener('tabchange', (e) => { if (e.detail === 'controllers') loadControllers(); });
window.toggleLogging = toggleLogging;
loadControllers();

export { loadControllers };
