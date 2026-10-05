import { BASE, fetchJson, ansi_up, escHtml } from './common.js';

let _currentCrashDecode = '';
let _currentCrashRaw = '';
let _currentCrashId = null;
let _currentCrashView = 'decoded';

function renderModalContent() {
  const body = document.getElementById('crash-modal-body');
  const rawToggle = document.getElementById('crash-raw-toggle');
  const rawView = _currentCrashView === 'raw';
  const content = rawView ? _currentCrashRaw : _currentCrashDecode;
  body.classList.toggle('raw-text', rawView || rawToggle.checked || !window.DOMPurify);

  if (rawView || rawToggle.checked || !window.DOMPurify) {
    body.textContent = content || (rawView ? 'Raw dump is not available for this crash.' : '');
    return;
  }

  // Check for AI analysis section delimiter
  const aiDelimiter = '--- AI Analysis ---';
  if (content.includes(aiDelimiter)) {
    const parts = content.split(aiDelimiter);
    const ansiLog = ansi_up.ansi_to_html(parts[0]);
    const markdownAnalysis = window.marked ? window.marked.parse(parts[1]) : escHtml(parts[1]);

    body.innerHTML = window.DOMPurify.sanitize(`
      <div class="ansi-block">${ansiLog}</div>
      <div class="ai-analysis-block">
        <h3 style="color:#4ec9b0;margin-bottom:8px">&#10024; AI Analysis</h3>
        ${markdownAnalysis}
      </div>
    `, { USE_PROFILES: { html: true } });
    return;
  }

  // Fallback: Escape ANSI to HTML spans first, then pass through Markdown parser
  const ansiHtml = ansi_up.ansi_to_html(content);
  if (window.marked) {
    body.innerHTML = window.DOMPurify.sanitize(window.marked.parse(ansiHtml, { gfm: true, breaks: true }), { USE_PROFILES: { html: true } });
  } else {
    body.innerHTML = window.DOMPurify.sanitize(ansiHtml, { USE_PROFILES: { html: true } });
  }
}

function openCrashModal(record) {
  const overlay = document.getElementById('crash-modal-overlay');
  const meta = document.getElementById('crash-modal-meta');
  const rawToggle = document.getElementById('crash-raw-toggle');
  const analyzeBtn = document.getElementById('crash-analyze-btn');
  const rerunBtn = document.getElementById('crash-rerun-btn');
  const rawTab = document.getElementById('crash-raw-tab');

  _currentCrashDecode = record.crashDecode || '';
  _currentCrashRaw = record.rawDump || record.crashRaw || record.raw || '';
  _currentCrashId = record.id || null;
  _currentCrashView = 'decoded';
  rawToggle.checked = false;
  rawTab.disabled = !_currentCrashRaw;
  document.getElementById('crash-decoded-tab').setAttribute('aria-selected', 'true');
  rawTab.setAttribute('aria-selected', 'false');
  const timeStr = record.receivedAt ? new Date(record.receivedAt).toLocaleTimeString() : '';
  const buildTags = [record.soc, record.gitVersion && `Firmware ${record.gitVersion}`, record.smingVersion && `Sming ${record.smingVersion}`].filter(Boolean);
  meta.textContent = [record.sourceIp, timeStr, ...buildTags].filter(Boolean).join(' · ');

  if (_currentCrashId) {
    analyzeBtn.style.display = 'inline-block';
    rerunBtn.style.display = 'inline-block';
  } else {
    analyzeBtn.style.display = 'none';
    rerunBtn.style.display = 'none';
  }

  rawToggle.onchange = renderModalContent;
  renderModalContent();

  overlay.classList.add('open');
}

function closeCrashModal() {
  document.getElementById('crash-modal-overlay').classList.remove('open');
  _currentCrashId = null;
}

document.getElementById('crash-close-btn').addEventListener('click', closeCrashModal);
document.getElementById('crash-modal-overlay').addEventListener('click', (e) => {
  if (e.target === document.getElementById('crash-modal-overlay')) closeCrashModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && document.getElementById('crash-modal-overlay').classList.contains('open')) {
    closeCrashModal();
  }
});

document.getElementById('crash-copy-btn').addEventListener('click', () => {
  const content = _currentCrashView === 'raw' ? _currentCrashRaw : _currentCrashDecode;
  if (!content) return;
  navigator.clipboard.writeText(content).then(() => {
    const btn = document.getElementById('crash-copy-btn');
    const orig = btn.textContent;
    btn.textContent = '✓ Copied!';
    setTimeout(() => { btn.textContent = orig; }, 1500);
  });
});

document.getElementById('crash-decoded-tab').addEventListener('click', () => {
  _currentCrashView = 'decoded';
  document.getElementById('crash-decoded-tab').setAttribute('aria-selected', 'true');
  document.getElementById('crash-raw-tab').setAttribute('aria-selected', 'false');
  renderModalContent();
});

document.getElementById('crash-raw-tab').addEventListener('click', () => {
  if (!_currentCrashRaw) return;
  _currentCrashView = 'raw';
  document.getElementById('crash-decoded-tab').setAttribute('aria-selected', 'false');
  document.getElementById('crash-raw-tab').setAttribute('aria-selected', 'true');
  renderModalContent();
});

document.getElementById('crash-analyze-btn').addEventListener('click', async () => {
  if (!_currentCrashId) return;
  const analyzeBtn = document.getElementById('crash-analyze-btn');
  const origText = analyzeBtn.textContent;
  analyzeBtn.disabled = true;
  analyzeBtn.textContent = 'Analyzing…';

  try {
    const res = await fetchJson(`${BASE}/api/v1/crashes/${_currentCrashId}/analyze`, {
      method: 'POST',
    });
    if (res && res.crashDecode) {
      _currentCrashDecode = res.crashDecode;
      if (res.rawDump) _currentCrashRaw = res.rawDump;
      document.getElementById('crash-raw-tab').disabled = !_currentCrashRaw;
      renderModalContent();
    }
    analyzeBtn.textContent = '✓ Analyzed!';
    setTimeout(() => { analyzeBtn.textContent = origText; analyzeBtn.disabled = false; }, 2000);
  } catch (err) {
    alert('AI analysis failed: ' + err.message);
    analyzeBtn.textContent = origText;
    analyzeBtn.disabled = false;
  }
});

document.getElementById('crash-rerun-btn').addEventListener('click', async () => {
  if (!_currentCrashId) return;
  const id = _currentCrashId;
  const rerunBtn = document.getElementById('crash-rerun-btn');
  const originalText = rerunBtn.textContent;
  rerunBtn.disabled = true;
  rerunBtn.textContent = 'Decoding…';

  try {
    const result = await fetchJson(`${BASE}/api/v1/crashes/${id}/decode`, { method: 'POST' });
    if (_currentCrashId === id && result?.crashDecode) {
      _currentCrashDecode = result.crashDecode;
      if (result.rawDump) _currentCrashRaw = result.rawDump;
      document.getElementById('crash-raw-tab').disabled = !_currentCrashRaw;
      renderModalContent();
      rerunBtn.textContent = '✓ Decoded';
    }
  } catch (err) {
    alert('Crash decoder rerun failed: ' + err.message);
  } finally {
    setTimeout(() => {
      rerunBtn.textContent = originalText;
      rerunBtn.disabled = false;
    }, 1200);
  }
});

/** Open the decode for `logId`, using an already-loaded row from `rows` when available. */
async function handleCrashBtnClick(logId, rows = [], fallbackIp = '') {
  const row = rows.find(r => r.id === logId);
  if (row && row.crashDecode) {
    openCrashModal({ ...row, sourceIp: row.sourceIp || fallbackIp });
    return;
  }
  try {
    const data = await fetchJson(`${BASE}/api/v1/logs/${logId}/crash-decode`);
    openCrashModal({ ...data, id: logId, crashDecode: data.crashDecode, sourceIp: fallbackIp });
  } catch (err) {
    alert('Could not load crash decode: ' + err.message);
  }
}

export { openCrashModal, handleCrashBtnClick };