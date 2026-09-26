import { BASE, fetchJson, ansi_up } from './common.js';

let _currentCrashDecode = '';
let _currentCrashId = null;

function openCrashModal(record) {
  const overlay = document.getElementById('crash-modal-overlay');
  const meta = document.getElementById('crash-modal-meta');
  const body = document.getElementById('crash-modal-body');
  const rawToggle = document.getElementById('crash-raw-toggle');
  const analyzeBtn = document.getElementById('crash-analyze-btn');

  _currentCrashDecode = record.crashDecode || '';
  _currentCrashId = record.id || null;
  const timeStr = record.receivedAt ? new Date(record.receivedAt).toLocaleTimeString() : '';
  meta.textContent = `${record.sourceIp || ''} · ${timeStr}`;

  if (_currentCrashId) {
    analyzeBtn.style.display = 'inline-block';
  } else {
    analyzeBtn.style.display = 'none';
  }

  function renderModalContent() {
    if (rawToggle.checked) {
      body.textContent = _currentCrashDecode;
    } else {
      body.innerHTML = ansi_up.ansi_to_html(_currentCrashDecode);
    }
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
  if (!_currentCrashDecode) return;
  navigator.clipboard.writeText(_currentCrashDecode).then(() => {
    const btn = document.getElementById('crash-copy-btn');
    const orig = btn.textContent;
    btn.textContent = '✓ Copied!';
    setTimeout(() => { btn.textContent = orig; }, 1500);
  });
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
      const rawToggle = document.getElementById('crash-raw-toggle');
      const body = document.getElementById('crash-modal-body');
      if (rawToggle.checked) {
        body.textContent = _currentCrashDecode;
      } else {
        body.innerHTML = ansi_up.ansi_to_html(_currentCrashDecode);
      }
    }
    analyzeBtn.textContent = '✓ Analyzed!';
    setTimeout(() => { analyzeBtn.textContent = origText; analyzeBtn.disabled = false; }, 2000);
  } catch (err) {
    alert('AI analysis failed: ' + err.message);
    analyzeBtn.textContent = origText;
    analyzeBtn.disabled = false;
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
    openCrashModal({ id: logId, crashDecode: data.crashDecode, sourceIp: fallbackIp });
  } catch (err) {
    alert('Could not load crash decode: ' + err.message);
  }
}

export { openCrashModal, handleCrashBtnClick };