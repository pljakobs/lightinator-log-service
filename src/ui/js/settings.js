import { BASE, fetchJson, escHtml } from './common.js';

const settingsOverlay = document.getElementById('settings-overlay');
let _lokiCfg = {};
let _clearLokiPassword = false;
let _svcLoaded = false;

function lokiPasswordUpdate() {
  if (_clearLokiPassword) return { password: null };
  const password = document.getElementById('loki-pass').value;
  return password ? { password } : {};
}

document.getElementById('loki-clear-pass').addEventListener('click', () => {
  _clearLokiPassword = true;
  const input = document.getElementById('loki-pass');
  input.value = '';
  input.placeholder = 'Cleared on save';
});
document.getElementById('loki-pass').addEventListener('input', () => {
  _clearLokiPassword = false;
});

document.getElementById('settings-btn').addEventListener('click', async () => {
  settingsOverlay.classList.add('open');
  activateSettingsTab('svc');
  await loadSvcSettings();
});
document.getElementById('settings-close').addEventListener('click', () => settingsOverlay.classList.remove('open'));
settingsOverlay.addEventListener('click', (e) => { if (e.target === settingsOverlay) settingsOverlay.classList.remove('open'); });

function activateSettingsTab(name) {
  document.querySelectorAll('.stab').forEach(b => b.classList.toggle('active', b.dataset.stab === name));
  for (const tab of ['svc', 'loki', 'ai', 'github']) {
    document.getElementById(`stab-${tab}`).style.display = tab === name ? '' : 'none';
  }
  document.getElementById('stab-footer-loki').style.display = name === 'loki' ? 'flex' : 'none';
  document.getElementById('stab-footer-svc').style.display  = name !== 'loki' ? 'flex' : 'none';
}

document.querySelectorAll('.stab').forEach(btn => {
  btn.addEventListener('click', async () => {
    activateSettingsTab(btn.dataset.stab);
    if (btn.dataset.stab === 'loki') await loadLokiConfig();
    if (btn.dataset.stab !== 'loki' && !_svcLoaded) await loadSvcSettings();
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
    _clearLokiPassword = false;
    document.getElementById('loki-pass').value = '';
    document.getElementById('loki-pass').placeholder = cfg.passwordConfigured ? 'Configured' : 'Not configured';
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
        ...lokiPasswordUpdate(),
        labels: labelsFromString(document.getElementById('loki-labels').value),
        groups: collectGroups(),
        controllers: collectControllers(),
        batchSize: Number(document.getElementById('loki-batch').value) || 100,
        flushIntervalMs: Number(document.getElementById('loki-interval').value) || 5000,
      }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
    await loadLokiConfig();
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
      ...lokiPasswordUpdate(),
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

function backendRowHtml(backend) {
  const ollama = backend.type === 'ollama';
  return `<div class="ai-backend-row" data-backend-id="${escHtml(backend.id)}">
    <label>API type<select data-ai-field="type">${['gemini', 'openai', 'ollama'].map(type => `<option value="${type}"${backend.type === type ? ' selected' : ''}>${type === 'openai' ? 'OpenAI-compatible' : type === 'ollama' ? 'Ollama' : 'Gemini'}</option>`).join('')}</select></label>
    <label>Base URL<input data-ai-field="baseUrl" type="url" value="${escHtml(backend.baseUrl || '')}" /></label>
    <label>Models<input data-ai-field="models" type="text" value="${escHtml((backend.models || []).join(', '))}" /></label>
    <label>Timeout (seconds)<input data-ai-field="timeoutSeconds" type="number" min="1" max="3600" step="1" value="${Math.round((backend.timeoutMs ?? (ollama ? 900000 : 60000)) / 1000)}" /></label>
    <label data-ai-field="numCtxLabel" style="display:${ollama ? 'flex' : 'none'}">Ollama context (tokens)<input data-ai-field="numCtx" type="number" min="2048" max="131072" step="1024" value="${backend.numCtx ?? 32768}" /></label>
    <label>Token<div class="ai-token-control"><input data-ai-field="token" type="password" autocomplete="new-password" value="" placeholder="${backend.tokenConfigured ? 'Configured' : 'Not configured'}" /><button type="button" data-ai-action="clear" title="Clear backend token" aria-label="Clear backend token">&times;</button></div></label>
    <div class="ai-backend-actions"><button type="button" data-ai-action="up" title="Move backend up" aria-label="Move backend up">&#8593;</button><button type="button" data-ai-action="down" title="Move backend down" aria-label="Move backend down">&#8595;</button><button type="button" data-ai-action="remove" title="Remove backend" aria-label="Remove backend">&times;</button></div>
  </div>`;
}

function collectAIBackends(container) {
  return [...container.querySelectorAll('.ai-backend-row')].map(row => {
    const field = name => row.querySelector(`[data-ai-field="${name}"]`);
    const token = field('token');
    return {
      id: row.dataset.backendId, type: field('type').value, baseUrl: field('baseUrl').value.trim(),
      models: field('models').value.split(',').map(model => model.trim()).filter(Boolean),
      timeoutMs: Number(field('timeoutSeconds').value) * 1000,
      ...(field('type').value === 'ollama' ? { numCtx: Number(field('numCtx').value) } : {}),
      ...(token.dataset.clearToken === 'true' ? { token: null } : token.value ? { token: token.value } : {}),
    };
  });
}

async function loadSvcSettings() {
  const st = document.getElementById('svc-status');
  st.textContent = 'Loading…'; st.style.color = '#888';
  try {
    const data = await fetchJson(`${BASE}/api/v1/service-config`);
    _svcSchema = data.schema || [];
    renderSvcFields(data.schema || [], data.values || {}, data.liveValues || {}, data.credentialsConfigured);
    _svcLoaded = true;
    st.textContent = (data.configurationErrors || []).join(' ');
  } catch (e) {
    st.textContent = 'Error: ' + e.message; st.style.color = '#f48771';
  }
}

function renderSvcFields(schema, savedValues, liveValues, credentialsConfigured = {}) {
  const container = document.createElement('div');
  const detectedHost = window.location.hostname;
  container.innerHTML = schema.map(s => {
    const saved = savedValues[s.key] ?? liveValues[s.key] ?? s.default ?? '';
    const live = liveValues[s.key] ?? '';
    const secret = s.writeOnly || s.type === 'password';
    const configured = credentialsConfigured[s.key] === true;
    let hint = `<div class="field-hint">Currently active: <code style="color:#9cdcfe">${escHtml(live || '(default)')}</code></div>`;
    if (secret) hint = `<div class="field-hint">${configured ? 'Configured' : 'Not configured'}</div>`;
    if (s.autoDetect) {
      hint += `<div class="field-hint">Detected from your browser URL: <a href="#" class="detect-link" data-key="${escHtml(s.key)}" data-val="${escHtml(detectedHost)}" style="color:#4ec9b0">${escHtml(detectedHost)}</a></div>`;
    }
    let control;
    if (s.type === 'ai-backends') {
      let backends = [];
      try { backends = JSON.parse(saved || '[]'); } catch {}
      control = `<div id="svc-field-${escHtml(s.key)}" class="ai-backends"><div class="ai-backend-list">${backends.map(backendRowHtml).join('')}</div><button type="button" data-ai-action="add">Add backend</button></div>`;
      hint = '';
    } else if (secret) {
      control = `<div style="display:flex;gap:6px"><input id="svc-field-${escHtml(s.key)}" type="password" value="" autocomplete="new-password" data-secret="true" placeholder="${configured ? 'Configured' : 'Not configured'}" style="min-width:0;flex:1" /><button type="button" class="svc-clear-secret" data-key="${escHtml(s.key)}" title="Clear saved credential" aria-label="Clear ${escHtml(s.label)}">&times;</button></div>`;
    } else if (s.type === 'boolean') {
      const checked = (savedValues[s.key] ?? liveValues[s.key] ?? s.default) === 'true';
      control = `<input id="svc-field-${escHtml(s.key)}" type="checkbox"${checked ? ' checked' : ''} />`;
    } else {
      control = `<input id="svc-field-${escHtml(s.key)}" type="${['number', 'url'].includes(s.type) ? s.type : 'text'}" value="${escHtml(saved)}"${s.readOnly ? ' readonly' : ''} placeholder="${escHtml(s.placeholder || '')}" style="font-family:monospace" />`;
    }
    return `<div class="field-row" data-category="${escHtml(s.category || 'Service')}" style="margin-bottom:8px">
      <label>${escHtml(s.label)}</label>
      ${control}
      ${hint}
      <div class="field-hint" style="color:#555">${escHtml(s.description)}</div>
    </div>`;
  }).join('');
  container.querySelectorAll('.ai-backends').forEach(editor => {
    editor.addEventListener('click', event => {
      const action = event.target.closest('[data-ai-action]')?.dataset.aiAction;
      if (!action) return;
      const list = editor.querySelector('.ai-backend-list');
      const row = event.target.closest('.ai-backend-row');
      if (action === 'add') {
        const element = document.createElement('div');
        element.innerHTML = backendRowHtml({ id: `backend-${Date.now()}`, type: 'openai', baseUrl: 'http://127.0.0.1:11434/v1', models: [] });
        list.appendChild(element.firstElementChild);
      } else if (action === 'remove') row.remove();
      else if (action === 'up' && row.previousElementSibling) list.insertBefore(row, row.previousElementSibling);
      else if (action === 'down' && row.nextElementSibling) list.insertBefore(row.nextElementSibling, row);
      else if (action === 'clear') {
        const input = row.querySelector('[data-ai-field="token"]');
        input.value = '';
        input.dataset.clearToken = 'true';
        input.placeholder = 'Cleared on save';
      }
    });
    editor.addEventListener('input', event => {
      if (event.target.dataset.aiField === 'token') delete event.target.dataset.clearToken;
    });
    editor.addEventListener('change', event => {
      if (event.target.matches('[data-ai-field="type"]')) {
        const row = event.target.closest('.ai-backend-row');
        row.querySelector('[data-ai-field="numCtxLabel"]').style.display = event.target.value === 'ollama' ? 'flex' : 'none';
      }
    });
  });
  container.querySelectorAll('.svc-clear-secret').forEach(button => {
    button.addEventListener('click', () => {
      const input = document.getElementById(`svc-field-${button.dataset.key}`);
      input.value = '';
      input.dataset.clearSecret = 'true';
      input.placeholder = 'Cleared on save';
    });
  });
  container.querySelectorAll('[data-secret]').forEach(input => {
    input.addEventListener('input', () => { delete input.dataset.clearSecret; });
  });
  container.querySelectorAll('.detect-link').forEach(a => {
    a.addEventListener('click', e => {
      e.preventDefault();
      const input = document.getElementById(`svc-field-${a.dataset.key}`);
      if (input) input.value = a.dataset.val;
    });
  });
  const targets = {
    Service: document.getElementById('svc-fields'),
    'AI Integration': document.getElementById('ai-fields'),
    'GitHub Integration': document.getElementById('github-fields'),
  };
  for (const target of Object.values(targets)) target.replaceChildren();
  for (const field of [...container.children]) (targets[field.dataset.category] || targets.Service).appendChild(field);
}

function collectSvcValues() {
  const values = {};
  for (const s of _svcSchema) {
    if (s.readOnly) continue;
    const el = document.getElementById(`svc-field-${s.key}`);
    if (!el) continue;
    if (s.type === 'ai-backends') {
      values[s.key] = JSON.stringify(collectAIBackends(el));
    } else if (el.dataset.secret) {
      if (el.dataset.clearSecret === 'true') values[s.key] = null;
      else if (el.value) values[s.key] = el.value;
    } else {
      values[s.key] = el.type === 'checkbox' ? String(el.checked) : el.value.trim();
    }
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
    await loadSvcSettings();
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
