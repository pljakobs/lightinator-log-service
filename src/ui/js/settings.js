import { BASE, fetchJson, escHtml } from './common.js';

const settingsOverlay = document.getElementById('settings-overlay');
let _lokiCfg = {};

document.getElementById('settings-btn').addEventListener('click', async () => {
  settingsOverlay.classList.add('open');
  activateSettingsTab('loki');
  await loadLokiConfig();
});
document.getElementById('settings-close').addEventListener('click', () => settingsOverlay.classList.remove('open'));
settingsOverlay.addEventListener('click', (e) => { if (e.target === settingsOverlay) settingsOverlay.classList.remove('open'); });

function activateSettingsTab(name) {
  document.querySelectorAll('.stab').forEach(b => b.classList.toggle('active', b.dataset.stab === name));
  document.getElementById('stab-loki').style.display = name === 'loki' ? '' : 'none';
  document.getElementById('stab-svc').style.display  = name === 'svc'  ? '' : 'none';
  document.getElementById('stab-footer-loki').style.display = name === 'loki' ? 'flex' : 'none';
  document.getElementById('stab-footer-svc').style.display  = name === 'svc'  ? 'flex' : 'none';
}

document.querySelectorAll('.stab').forEach(btn => {
  btn.addEventListener('click', async () => {
    activateSettingsTab(btn.dataset.stab);
    if (btn.dataset.stab === 'loki') await loadLokiConfig();
    if (btn.dataset.stab === 'svc')  await loadSvcSettings();
  });
});

function labelsFromString(s) {
  const obj = {};
  for (const part of String(s).split(',')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k) obj[k] = v;
  }
  return obj;
}

function labelsToString(obj) {
  return Object.entries(obj || {}).map(([k,v]) => `${k}=${v}`).join(', ');
}

function renderGroups() {
  const list = document.getElementById('groups-list');
  list.innerHTML = '';
  const groups = _lokiCfg.groups || {};
  for (const [name, labels] of Object.entries(groups)) {
    const row = document.createElement('div');
    row.className = 'tag-row';
    row.dataset.group = name;
    row.innerHTML = `<input type="text" value="${escHtml(name)}" placeholder="group name" />
      <input type="text" value="${escHtml(labelsToString(labels))}" placeholder="key=value, …" />
      <button class="remove-btn" title="Remove group">&times;</button>`;
    row.querySelector('.remove-btn').addEventListener('click', () => {
      delete _lokiCfg.groups[name];
      for (const c of Object.values(_lokiCfg.controllers || {})) {
        if (c.group === name) c.group = '';
      }
      renderGroups();
      renderControllers();
    });
    list.appendChild(row);
  }
}

function collectGroups() {
  const groups = {};
  for (const row of document.querySelectorAll('#groups-list .tag-row')) {
    const inputs = row.querySelectorAll('input');
    const name = inputs[0].value.trim();
    if (!name) continue;
    groups[name] = labelsFromString(inputs[1].value);
  }
  return groups;
}

document.getElementById('add-group-btn').addEventListener('click', () => {
  _lokiCfg.groups = collectGroups();
  const newName = 'group' + (Object.keys(_lokiCfg.groups).length + 1);
  _lokiCfg.groups[newName] = {};
  renderGroups();
  renderControllers();
});

function groupOptions(selected) {
  const groups = collectGroups();
  const opts = ['<option value="">(none)</option>'];
  for (const g of Object.keys(groups)) {
    opts.push(`<option value="${escHtml(g)}"${g===selected?' selected':''}>${escHtml(g)}</option>`);
  }
  return opts.join('');
}

function renderControllers() {
  const list = document.getElementById('controllers-list');
  list.innerHTML = '';
  const controllers = _lokiCfg.controllers || {};
  for (const [ip, cfg] of Object.entries(controllers)) {
    appendControllerRow(list, ip, cfg.group || '', cfg.labels || {});
  }
}

function appendControllerRow(list, ip, group, labels) {
  const row = document.createElement('div');
  row.className = 'tag-row';
  row.style.gridTemplateColumns = '130px 1fr 1fr auto';
  row.innerHTML = `<input type="text" value="${escHtml(ip)}" placeholder="192.168.x.x" />
    <select>${groupOptions(group)}</select>
    <input type="text" value="${escHtml(labelsToString(labels))}" placeholder="name=ceiling, … (optional)" />
    <button class="remove-btn" title="Remove">&times;</button>`;
  row.querySelector('.remove-btn').addEventListener('click', () => row.remove());
  list.appendChild(row);
}

function collectControllers() {
  const contrs = {};
  for (const row of document.querySelectorAll('#controllers-list .tag-row')) {
    const inputs = row.querySelectorAll('input');
    const ip = inputs[0].value.trim();
    if (!ip) continue;
    const group = row.querySelector('select').value;
    const labels = labelsFromString(inputs[1].value);
    contrs[ip] = { group, labels };
  }
  return contrs;
}

document.getElementById('add-controller-btn').addEventListener('click', () => {
  _lokiCfg.groups = collectGroups();
  appendControllerRow(document.getElementById('controllers-list'), '', '', {});
});

async function loadLokiConfig() {
  const st = document.getElementById('loki-status');
  try {
    const [cfg, sources] = await Promise.all([
      fetchJson(`${BASE}/api/v1/loki/config`),
      fetchJson(`${BASE}/api/v1/sources`).then(d => d.items || []).catch(() => []),
    ]);
    _lokiCfg = cfg;
    _lokiCfg.groups = cfg.groups || {};
    _lokiCfg.controllers = cfg.controllers || {};

    for (const src of sources) {
      if (!_lokiCfg.controllers[src.ip]) {
        _lokiCfg.controllers[src.ip] = { group: '', labels: {} };
      }
    }

    document.getElementById('loki-enabled').checked = !!cfg.enabled;
    document.getElementById('loki-url').value = cfg.url || 'http://localhost:3100';
    document.getElementById('loki-user').value = cfg.username || '';
    document.getElementById('loki-pass').value = cfg.password || '';
    document.getElementById('loki-labels').value = labelsToString(cfg.labels);
    document.getElementById('loki-batch').value = cfg.batchSize || 100;
    document.getElementById('loki-interval').value = cfg.flushIntervalMs || 5000;
    renderGroups();
    renderControllers();
    st.textContent = '';
  } catch (e) {
    st.textContent = 'Failed to load config'; st.style.color = '#f48771';
  }
}

document.getElementById('loki-save').addEventListener('click', async () => {
  const st = document.getElementById('loki-status');
  st.textContent = 'Saving…'; st.style.color = '#888';
  try {
    const r = await fetch(`${BASE}/api/v1/loki/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        enabled: document.getElementById('loki-enabled').checked,
        url: document.getElementById('loki-url').value.trim(),
        username: document.getElementById('loki-user').value,
        password: document.getElementById('loki-pass').value,
        labels: labelsFromString(document.getElementById('loki-labels').value),
        groups: collectGroups(),
        controllers: collectControllers(),
        batchSize: Number(document.getElementById('loki-batch').value) || 100,
        flushIntervalMs: Number(document.getElementById('loki-interval').value) || 5000,
      }),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    st.textContent = '✓ Saved'; st.style.color = '#4ec9b0';
  } catch (e) {
    st.textContent = '✗ ' + e.message; st.style.color = '#f48771';
  }
});

document.getElementById('loki-test').addEventListener('click', async () => {
  const st = document.getElementById('loki-status');
  st.textContent = 'Testing…'; st.style.color = '#888';
  try {
    const testBody = {
      url: document.getElementById('loki-url').value.trim(),
      username: document.getElementById('loki-user').value,
      password: document.getElementById('loki-pass').value,
    };
    const r = await fetch(`${BASE}/api/v1/loki/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(testBody),
    });
    const data = await r.json().catch(() => ({}));
    const target = data.target ? ` \u2192 ${data.target}` : '';
    if (r.ok) {
      st.textContent = `\u2713 ${data.message || 'OK'}${target}`; st.style.color = '#4ec9b0';
    } else {
      st.textContent = `\u2717 ${target ? target + ': ' : ''}${data.error || `HTTP ${r.status}`}`; st.style.color = '#f48771';
    }
  } catch (e) {
    st.textContent = '✗ ' + e.message; st.style.color = '#f48771';
  }
});

let _svcSchema = [];

async function loadSvcSettings() {
  const st = document.getElementById('svc-status');
  st.textContent = 'Loading…'; st.style.color = '#888';
  try {
    const data = await fetchJson(`${BASE}/api/v1/service-config`);
    _svcSchema = data.schema || [];
    renderSvcFields(data.schema, data.values, data.liveValues);
    st.textContent = '';
  } catch (e) {
    st.textContent = 'Error: ' + e.message; st.style.color = '#f48771';
  }
}

function renderSvcFields(schema, savedValues, liveValues) {
  const container = document.getElementById('svc-fields');
  const detectedHost = window.location.hostname;
  container.innerHTML = schema.map(s => {
    const saved = savedValues[s.key] ?? '';
    const live = liveValues[s.key] ?? '';
    let hint = `<div class="field-hint">Currently active: <code style="color:#9cdcfe">${escHtml(live || '(default)')}</code></div>`;
    if (s.autoDetect) {
      hint += `<div class="field-hint">Detected from your browser URL: <a href="#" class="detect-link" data-key="${escHtml(s.key)}" data-val="${escHtml(detectedHost)}" style="color:#4ec9b0">${escHtml(detectedHost)}</a></div>`;
    }
    return `<div class="field-row" style="margin-bottom:8px">
      <label>${escHtml(s.label)}</label>
      <input id="svc-field-${escHtml(s.key)}" type="${s.type === 'number' ? 'number' : 'text'}" value="${escHtml(saved)}" placeholder="${escHtml(s.placeholder || '')}" style="font-family:monospace" />
      ${hint}
      <div class="field-hint" style="color:#555">${escHtml(s.description)}</div>
    </div>`;
  }).join('');
  container.querySelectorAll('.detect-link').forEach(a => {
    a.addEventListener('click', e => {
      e.preventDefault();
      const input = document.getElementById(`svc-field-${a.dataset.key}`);
      if (input) input.value = a.dataset.val;
    });
  });
}

function collectSvcValues() {
  const values = {};
  for (const s of _svcSchema) {
    const el = document.getElementById(`svc-field-${s.key}`);
    if (el) values[s.key] = el.value.trim();
  }
  return values;
}

async function saveSvcSettings(andRestart) {
  const st = document.getElementById('svc-status');
  st.textContent = 'Saving…'; st.style.color = '#888';
  try {
    const r = await fetch(`${BASE}/api/v1/service-config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: collectSvcValues() }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
    if (andRestart) {
      st.textContent = 'Saved. Restarting…'; st.style.color = '#4ec9b0';
      await fetch(`${BASE}/api/v1/service-config/restart`, { method: 'POST' });
      setTimeout(() => { st.textContent = 'Restarted.'; }, 2000);
    } else {
      st.textContent = '✓ Saved — restart service to apply changes'; st.style.color = '#4ec9b0';
    }
  } catch (e) {
    st.textContent = '✗ ' + e.message; st.style.color = '#f48771';
  }
}

document.getElementById('svc-save').addEventListener('click', () => saveSvcSettings(false));
document.getElementById('svc-restart').addEventListener('click', () => saveSvcSettings(true));
