import { BASE, fetchJson, downloadFile, ansi_up, escHtml } from './common.js';

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

  const uploadBtn = document.getElementById('crash-upload-btn');
  if (_currentCrashId) {
    analyzeBtn.style.display = 'inline-block';
    rerunBtn.style.display = 'inline-block';
    uploadBtn.style.display = 'inline-block';
    uploadBtn.title = UPLOAD_BTN_TITLE;
    _artifactStatusFor = null;
  } else {
    analyzeBtn.style.display = 'none';
    rerunBtn.style.display = 'none';
    uploadBtn.style.display = 'none';
  }
  document.getElementById('crash-download-group').style.display = _currentCrashId ? 'inline-flex' : 'none';

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

document.getElementById('crash-download-btn').addEventListener('click', () => {
  if (!_currentCrashId) return;
  const query = new URLSearchParams({ scope: 'crash', id: _currentCrashId });
  const minutes = document.getElementById('crash-download-minutes').value;
  if (minutes) query.set('minutes', minutes);
  downloadFile(`${BASE}/api/v1/logs/download?${query}`);
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
  const crashId = _currentCrashId;
  const analyzeBtn = document.getElementById('crash-analyze-btn');
  const progress = document.getElementById('crash-analysis-progress');
  const stage = document.getElementById('crash-analysis-stage');
  const modelStatus = document.getElementById('crash-analysis-model-status');
  const thinkingText = document.getElementById('crash-analysis-thinking');
  const throughput = document.getElementById('crash-analysis-throughput');
  const contextPanel = document.getElementById('crash-analysis-context');
  const contextRows = document.getElementById('crash-analysis-context-rows');
  const streamedText = document.getElementById('crash-analysis-stream');
  const origText = analyzeBtn.textContent;
  analyzeBtn.disabled = true;
  analyzeBtn.textContent = 'Analyzing…';
  stage.textContent = 'Waiting for the analysis queue…';
  contextRows.replaceChildren();
  contextPanel.hidden = true;
  streamedText.textContent = '';
  streamedText.hidden = true;
  progress.hidden = false;

  try {
    const response = await fetch(`${BASE}/api/v1/crashes/${crashId}/analyze/stream`, {
      method: 'POST',
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error || `HTTP ${response.status}`);
    }
    if (!response.body) throw new Error('Streaming response is unavailable in this browser.');

    let buffer = '';
    let result = null;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
      let thinkingCharacters = 0;
      let responseCharacters = 0;
      let modelStartedAt = 0;
      let streamedCharacters = 0;
      const updateModelStatus = () => {
        modelStatus.textContent = thinkingCharacters
          ? `Thinking text: ${thinkingCharacters.toLocaleString()} characters received; ${responseCharacters.toLocaleString()} answer characters streamed`
          : responseCharacters
            ? `Answer progress: ${responseCharacters.toLocaleString()} characters streamed`
            : 'Waiting for model activity…';
        const elapsedSeconds = modelStartedAt ? Math.max(0.1, (Date.now() - modelStartedAt) / 1000) : 0;
        const approximateTokensPerSecond = elapsedSeconds ? Math.round(streamedCharacters / 4 / elapsedSeconds) : 0;
        throughput.textContent = elapsedSeconds
          ? `Approx. throughput: ${approximateTokensPerSecond.toLocaleString()} tokens/s (estimated from streamed characters)`
          : 'Approx. throughput: waiting for stream…';
      };
    const consumeLine = line => {
      if (!line.trim()) return;
      const event = JSON.parse(line);
      if (event.type === 'stage') {
        stage.textContent = event.stage === 'repositories' ? 'Preparing firmware sources…'
          : event.stage === 'decoding' ? 'Decoding crash dump…'
          : event.stage === 'map' ? 'Loading symbols and map data…'
          : event.stage === 'context' ? 'Gathering supplemental source context…'
          : event.stage === 'evidence' ? 'Reviewing crash evidence and source…'
          : event.stage === 'evidence-model' ? 'Analyzing crash evidence…'
          : event.stage === 'evidence-retry' ? 'Retrying crash evidence analysis…'
          : event.stage === 'final' ? 'Generating final analysis…' : 'Waiting for the analysis queue…';
      } else if (event.type === 'context') {
        if (event.phase === 'initial') contextRows.replaceChildren();
        contextPanel.hidden = false;
        if (event.phase === 'initial' && !event.files?.length) {
          const row = document.createElement('tr');
          const cell = document.createElement('td');
          cell.colSpan = 3;
          cell.textContent = 'No source snippets selected';
          row.appendChild(cell);
          contextRows.appendChild(row);
        }
        for (const file of event.files || []) {
          const row = document.createElement('tr');
          const values = [file.repo, file.file, file.startLine ? `${file.startLine}${file.stopLine && file.stopLine !== file.startLine ? `–${file.stopLine}` : ''}` : 'Full file'];
          for (const value of values) {
            const cell = document.createElement('td');
            cell.textContent = value || '';
            row.appendChild(cell);
          }
          contextRows.appendChild(row);
        }
      } else if (event.type === 'reset') {
        streamedText.textContent = '';
        streamedText.hidden = true;
        thinkingText.textContent = '';
        thinkingText.hidden = true;
        thinkingCharacters = 0;
        responseCharacters = 0;
        streamedCharacters = 0;
        modelStartedAt = Date.now();
        updateModelStatus();
        stage.textContent = `Generating with ${event.model}…`;
      } else if (event.type === 'token') {
        streamedText.hidden = false;
        streamedText.textContent += event.text;
        if (!modelStartedAt) modelStartedAt = Date.now();
        responseCharacters += event.text.length;
        streamedCharacters += event.text.length;
        updateModelStatus();
        streamedText.scrollTop = streamedText.scrollHeight;
      } else if (event.type === 'activity' && event.activity === 'thinking') {
        thinkingText.hidden = false;
        thinkingText.textContent += event.text || '';
        thinkingText.scrollTop = thinkingText.scrollHeight;
        if (!modelStartedAt) modelStartedAt = Date.now();
        thinkingCharacters = event.characters || thinkingCharacters;
        streamedCharacters += (event.text || '').length;
        updateModelStatus();
        stage.textContent = 'Model is generating its analysis…';
      } else if (event.type === 'retry') {
        stage.textContent = `Retrying after ${event.model} failed…`;
      } else if (event.type === 'complete') {
        result = event;
      } else if (event.type === 'error') {
        throw new Error(event.error || 'AI analysis failed.');
      }
    };
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) consumeLine(line);
      if (done) break;
    }
    if (buffer.trim()) consumeLine(buffer);
    if (!result) throw new Error('Analysis stream ended before completion.');

    const res = result;
    if (_currentCrashId === crashId && res && res.crashDecode) {
      _currentCrashDecode = res.crashDecode;
      if (res.rawDump) _currentCrashRaw = res.rawDump;
      document.getElementById('crash-raw-tab').disabled = !_currentCrashRaw;
      renderModalContent();
    }
    if (_currentCrashId === crashId) {
      analyzeBtn.textContent = '✓ Analyzed!';
      setTimeout(() => { analyzeBtn.textContent = origText; analyzeBtn.disabled = false; }, 2000);
    }
  } catch (err) {
    if (_currentCrashId === crashId) {
      alert('AI analysis failed: ' + err.message);
      analyzeBtn.textContent = origText;
      analyzeBtn.disabled = false;
    }
  } finally {
    progress.hidden = true;
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

const UPLOAD_BTN_TITLE = 'Upload the ELF (app.out / app_0.out) and optionally the .map of the build that crashed, then rerun the decoder';

function describeArtifact(label, info) {
  if (!info?.present) return `${label}: not cached`;
  if (info.source !== 'uploaded') return `${label}: downloaded`;
  return `${label}: uploaded${info.originalName ? ` ${info.originalName}` : ''} ${info.uploadedAt ? new Date(info.uploadedAt).toLocaleString() : ''}`.trim();
}

let _artifactStatusFor = null;

async function refreshArtifactStatus(id) {
  const uploadBtn = document.getElementById('crash-upload-btn');
  _artifactStatusFor = id;
  try {
    const status = await fetchJson(`${BASE}/api/v1/crashes/${id}/artifacts`);
    if (_currentCrashId !== id) return;
    uploadBtn.title = `${UPLOAD_BTN_TITLE}\n\nFirmware ${status.gitVersion} · ${status.soc} · ${status.buildType}\n${describeArtifact('ELF', status.elf)}\n${describeArtifact('Map', status.map)}`;
  } catch {
    // Status is informational; the upload itself reports errors.
  }
}

function classifyArtifactFiles(files) {
  const byKind = { elf: [], map: [] };
  for (const file of files) byKind[/\.map$/i.test(file.name) ? 'map' : 'elf'].push(file);
  if (byKind.elf.length > 1 || byKind.map.length > 1) throw new Error('Select at most one ELF and one map file.');
  return { elf: byKind.elf[0] || null, map: byKind.map[0] || null };
}

// Cached artifact status is loaded on demand for the button tooltip.
for (const event of ['mouseenter', 'focus']) {
  document.getElementById('crash-upload-btn').addEventListener(event, () => {
    if (_currentCrashId && _artifactStatusFor !== _currentCrashId) refreshArtifactStatus(_currentCrashId);
  });
}

document.getElementById('crash-upload-btn').addEventListener('click', () => {
  if (!_currentCrashId) return;
  const input = document.getElementById('crash-upload-input');
  input.value = '';
  input.click();
});

document.getElementById('crash-upload-input').addEventListener('change', async (e) => {
  const files = [...(e.target.files || [])];
  if (!_currentCrashId || !files.length) return;
  const id = _currentCrashId;
  const uploadBtn = document.getElementById('crash-upload-btn');
  const originalText = uploadBtn.textContent;
  uploadBtn.disabled = true;

  try {
    const { elf, map } = classifyArtifactFiles(files);
    // ELF first: installing a new ELF discards any map cached for that firmware version.
    for (const [kind, file] of [['elf', elf], ['map', map]]) {
      if (!file) continue;
      uploadBtn.textContent = `Uploading ${kind.toUpperCase()}…`;
      await fetchJson(`${BASE}/api/v1/crashes/${id}/artifacts/${kind}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': file.name },
        body: file,
      });
    }
    uploadBtn.textContent = 'Decoding…';
    const result = await fetchJson(`${BASE}/api/v1/crashes/${id}/decode`, { method: 'POST' });
    if (_currentCrashId === id && result?.crashDecode) {
      _currentCrashDecode = result.crashDecode;
      if (result.rawDump) _currentCrashRaw = result.rawDump;
      document.getElementById('crash-raw-tab').disabled = !_currentCrashRaw;
      renderModalContent();
      uploadBtn.textContent = '✓ Decoded';
      refreshArtifactStatus(id);
    }
  } catch (err) {
    alert('Artifact upload failed: ' + err.message);
  } finally {
    setTimeout(() => {
      uploadBtn.textContent = originalText;
      uploadBtn.disabled = false;
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