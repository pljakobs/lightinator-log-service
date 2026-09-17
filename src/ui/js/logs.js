import { BASE, fetchJson, escHtml, timeAgo, severityClass, fmtLogTime, ansi_up, activateTab } from './common.js';
import { handleCrashBtnClick } from './crash.js';

let currentIp = null;
let nextBefore = null;
// cursor for newer rows; null = window ends at the live tail
let nextAfter = null;
let allRows = [];
let refreshTimer = null;
let _lastRenderFilter = '';
let _lastRenderIp = null;

const sourcesList = document.getElementById('sources-list');
const logList = document.getElementById('log-list');
const logTitle = document.getElementById('log-title');
const logCount = document.getElementById('log-count');
const pagerInfo = document.getElementById('pager-info');
const loadOlderBtn  = document.getElementById('load-older-btn');
const bootPrevBtn   = document.getElementById('boot-prev-btn');
const bootNextBtn   = document.getElementById('boot-next-btn');
const purgeBtn = document.getElementById('purge-btn');
const filterInput = document.getElementById('filter-input');
const autoRefresh = document.getElementById('auto-refresh');
const autoScroll = document.getElementById('auto-scroll');
const jumpEndBtn = document.getElementById('jump-end-btn');
const status = document.getElementById('status');

async function loadSources() {
  try {
    const [srcData, ctrlData] = await Promise.all([
      fetchJson(`${BASE}/api/v1/sources`),
      fetchJson(`${BASE}/api/v1/controllers`).catch(() => ({ items: [] })),
    ]);
    const byIp = new Map();
    for (const c of (ctrlData.items || [])) {
      byIp.set(c.ip, { ip: c.ip, name: c.name || c.hostname || c.ip, bytes: 0, lastSeen: null });
    }
    for (const s of (srcData.items || [])) {
      const existing = byIp.get(s.ip) || { ip: s.ip, name: s.ip };
      byIp.set(s.ip, { ...existing, bytes: s.bytes, lastSeen: s.lastSeen });
    }
    renderSources([...byIp.values()]);
    status.textContent = `Updated ${new Date().toLocaleTimeString()}`;
  } catch (e) {
    status.textContent = 'Error loading sources';
  }
}

function renderSources(items) {
  sourcesList.innerHTML = '';
  if (!items.length) {
    sourcesList.innerHTML = '<div style="padding:12px;color:#666;font-size:11px">No sources yet</div>';
    return;
  }
  for (const src of items) {
    const el = document.createElement('div');
    el.className = 'source-item' + (src.ip === currentIp ? ' active' : '');
    const label = src.name && src.name !== src.ip ? `<span class="source-ip">${escHtml(src.name)}</span><span class="source-meta">${escHtml(src.ip)}</span>` :
      `<span class="source-ip">${escHtml(src.ip)}</span>`;
    const meta = (src.bytes ? Math.ceil(src.bytes/1024)+'KB ' : '') + (src.lastSeen ? timeAgo(src.lastSeen) : '');
    el.innerHTML = label + `<span class="source-meta">${meta}</span>`;
    el.addEventListener('click', () => selectSource(src.ip));
    sourcesList.appendChild(el);
  }
}

async function selectSource(ip) {
  activateTab('logs');
  currentIp = ip;
  allRows = [];
  nextBefore = null;
  nextAfter = null;
  logTitle.textContent = ip;
  loadOlderBtn.style.display = 'none';
  purgeBtn.style.display = '';
  document.querySelectorAll('.source-item').forEach(el => {
    el.classList.toggle('active', el.querySelector('.source-ip').textContent === ip);
  });
  await fetchLogs();
}

// mode: 'tail' (live refresh, no-op while viewing history), 'older' (prepend),
//       'newer' (append), 'jump' (replace window, starting at `from`)
async function fetchLogs({ before = null, from = null, mode = 'tail' } = {}) {
  if (!currentIp) return;
  if (mode === 'tail' && nextAfter != null) return;
  try {
    let url = `${BASE}/api/v1/logs?ip=${encodeURIComponent(currentIp)}&limit=200`;
    if (from != null) url += `&from=${from}`;
    else if (before != null) url += `&before=${before}`;
    const data = await fetchJson(url);

    const existingIds = new Set(allRows.map(r => r.id));
    const newItems = data.items.filter(r => !existingIds.has(r.id));
    if (mode === 'jump') {
      allRows = data.items;
      nextBefore = data.nextBefore;
      nextAfter = data.nextAfter;
    } else if (mode === 'older') {
      allRows = [...newItems, ...allRows];
      nextBefore = data.nextBefore;
    } else if (mode === 'newer') {
      allRows = [...allRows, ...newItems];
      nextAfter = data.nextAfter;
    } else {
      const wasEmpty = allRows.length === 0;
      allRows = [...allRows, ...newItems];
      if (wasEmpty) nextBefore = data.nextBefore;
      nextAfter = null;
    }

    logCount.textContent = `${data.total} entries`;
    pagerInfo.textContent = nextAfter != null ? `Showing ${allRows.length} of ${data.total} (history)` :
      nextBefore != null ? `Showing last ${allRows.length} of ${data.total}` : `All ${allRows.length} entries`;
    loadOlderBtn.style.display = nextBefore != null ? '' : 'none';
    renderLogs(mode === 'tail' ? 'keep' : mode === 'jump' ? 'top' : mode);
    updateBootNavButtons();
  } catch (e) {
    logList.innerHTML = `<div class="empty">Error: ${e.message}</div>`;
  }
}

const columns = [
  { id: 'time', label: 'Time',    width: 160, visible: true },
  { id: 'tag',  label: 'Tag',     width: 90,  visible: true },
  { id: 'app',  label: 'App',     width: 140, visible: true },
  { id: 'msg',  label: 'Message', width: null, visible: true },
];

const colStyleEl = document.createElement('style');
document.head.appendChild(colStyleEl);

function saveColState() {
  try { localStorage.setItem('lls-columns', JSON.stringify(columns.map(c => ({ id: c.id, width: c.width, visible: c.visible })))); } catch {}
}

function loadColState() {
  try {
    const saved = JSON.parse(localStorage.getItem('lls-columns') || '[]');
    for (const s of saved) {
      const col = columns.find(c => c.id === s.id);
      if (col) { if (s.width != null) col.width = s.width; if (s.visible != null) col.visible = s.visible; }
    }
  } catch {}
}

function updateGridTemplate() {
  const rawMode = document.getElementById('raw-mode-toggle')?.checked;
  if (rawMode) {
    colStyleEl.textContent = '#log-header-row { grid-template-columns: 1fr; }';
  } else {
    const tpl = columns.filter(c => c.visible).map(c => c.id === 'msg' ? '1fr' : c.width + 'px').join(' ');
    colStyleEl.textContent = `.log-row, #log-header-row { grid-template-columns: ${tpl}; }`;
  }
  renderHeader();
}

function renderHeader() {
  const hdr = document.getElementById('log-header-row');
  if (!hdr) return;
  const rawMode = document.getElementById('raw-mode-toggle')?.checked;
  if (rawMode) { hdr.innerHTML = '<div class="hdr-cell">Raw</div>'; return; }
  hdr.innerHTML = columns.filter(c => c.visible).map(c =>
    `<div class="hdr-cell">${escHtml(c.label)}${c.id !== 'msg' ? `<span class="resize-handle" data-col="${c.id}"></span>` : ''}</div>`
  ).join('');
  hdr.querySelectorAll('.resize-handle').forEach(h => h.addEventListener('mousedown', startResize));
}

function startResize(e) {
  e.preventDefault();
  const col = columns.find(c => c.id === e.target.dataset.col);
  if (!col) return;
  e.target.classList.add('active');
  const startX = e.clientX, startW = col.width;
  function onMove(ev) { col.width = Math.max(40, startW + (ev.clientX - startX)); updateGridTemplate(); }
  function onUp() {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    saveColState();
  }
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

// scrollMode: 'keep' (stick to bottom if already there), 'top', 'older' (keep
// viewport anchored on the same rows after prepending), 'newer' (keep position)
function renderLogs(scrollMode = 'keep') {
  const rawFilter = filterInput.value.trim();
  let bootFilter = null;
  let textFilter = rawFilter.toLowerCase();
  const bootMatch = rawFilter.match(/(?:^|\s)boot:(-?\d+)(?:\s|$)/i);
  if (bootMatch) {
    bootFilter = parseInt(bootMatch[1], 10);
    textFilter = rawFilter.replace(bootMatch[0], ' ').trim().toLowerCase();
  }
  if (bootFilter !== null && bootFilter < 0) {
    const maxBoot = allRows.reduce((m, r) => Math.max(m, r.boot ?? 0), 0);
    bootFilter = maxBoot + 1 + bootFilter;
  }
  const shouldAnchorBootHead = bootFilter !== null && (rawFilter !== _lastRenderFilter || currentIp !== _lastRenderIp);

  const ctxRaw = parseInt(document.getElementById('context-input').value, 10);
  const ctxUnlimited = ctxRaw === -1;
  const ctxN = ctxUnlimited ? 0 : Math.max(0, ctxRaw || 0);

  const bootRows = bootFilter !== null ? allRows.filter(r => (r.boot ?? 0) === bootFilter) : allRows;

  let displayRows;
  if (textFilter) {
    const matchIndices = new Set();
    bootRows.forEach((r, i) => {
      if ((r.message||'').toLowerCase().includes(textFilter) || (r.tag||'').toLowerCase().includes(textFilter))
        matchIndices.add(i);
    });
    if (ctxUnlimited) {
      displayRows = bootRows.map((row, i) => ({ row, isContext: !matchIndices.has(i) }));
    } else {
      const included = new Set();
      for (const idx of matchIndices) {
        for (let j = Math.max(0, idx - ctxN); j <= Math.min(bootRows.length - 1, idx + ctxN); j++)
          included.add(j);
      }
      displayRows = [...included].sort((a,b) => a-b).map(i => ({ row: bootRows[i], isContext: !matchIndices.has(i), srcIdx: i }));
      for (let di = 1; di < displayRows.length; di++) {
        if (displayRows[di].srcIdx !== displayRows[di - 1].srcIdx + 1)
          displayRows[di].hasGapBefore = true;
      }
    }
  } else {
    displayRows = bootRows.map(r => ({ row: r, isContext: false }));
  }

  if (document.getElementById('sort-device-time').checked) {
    displayRows = displayRows
      .map((r, i) => ({ r, i }))
      .sort((a, b) => {
        const ba = a.r.row.boot ?? 0;
        const bb = b.r.row.boot ?? 0;
        if (ba !== bb) return ba - bb;
        const ta = a.r.row.deviceTime ?? Infinity;
        const tb = b.r.row.deviceTime ?? Infinity;
        if (ta !== tb) return ta - tb;
        return a.i - b.i;
      })
      .map(({ r }) => r);
  }

  if (!displayRows.length) {
    logList.innerHTML = '<div class="empty">No log entries</div>';
    return;
  }

  const wasAtBottom = logList.scrollHeight - logList.scrollTop <= logList.clientHeight + 8;
  const prevScrollHeight = logList.scrollHeight;
  const prevScrollTop = logList.scrollTop;

  const rawMode = document.getElementById('raw-mode-toggle').checked;
  const parts = [];
  let lastBoot = undefined;
  const markedBoots = new Set();
  for (const { row: r, isContext, hasGapBefore } of displayRows) {
    if (!rawMode && hasGapBefore) {
      parts.push('<div class="context-divider">&hellip;</div>');
    }
    // bootStart is set by the server (row's boot differs from the preceding stored row);
    // the second clause covers filtered views where the actual boot-start row is hidden
    if (!rawMode && r.boot !== undefined && !markedBoots.has(r.boot) &&
        (r.bootStart || (lastBoot !== undefined && r.boot !== lastBoot))) {
      parts.push(`<div class="reboot-marker" data-boot="${r.boot}"><span class="reboot-marker-label">&#x21bb; boot ${r.boot}</span></div>`);
      markedBoots.add(r.boot);
    }
    if (r.boot !== undefined) lastBoot = r.boot;
    const cls = severityClass(r.priority);
    const extraCls = isContext ? ' context' : '';
    const isPending = r.crashDecode && r.crashDecode.includes('decoding in progress');
    const crashBtn = r.crashDecode ? `<button class="crash-btn${isPending ? ' pending' : ''}" data-id="${r.id}" title="${isPending ? 'Crash decode in progress…' : 'Click to view decoded stack trace'}">${isPending ? '&#x23F3; Decoding Crash…' : '&#x1F50D; View Crash Decode'}</button>` : '';
    if (rawMode) {
      parts.push(`<div class="log-row raw-row${cls?' '+cls:''}${extraCls}">${crashBtn}${escHtml(r.raw||'')}</div>`);
      continue;
    }
    const time = fmtLogTime(r.receivedAt);
    const cellMap = {
      time: `<span class="col-time">${time}</span>`,
      tag:  `<span class="col-tag" title="${escHtml(r.tag||'')}">${escHtml(r.tag||'')}</span>`,
      app:  `<span class="col-app" title="${escHtml(r.app||'')}">${escHtml(r.app||'')}</span>`,
      msg:  `<span class="col-msg">${crashBtn}${ansi_up.ansi_to_html(r.message||r.raw||'')}</span>`,
    };
    parts.push(`<div class="log-row${cls?' '+cls:''}${extraCls}">${columns.filter(c => c.visible).map(c => cellMap[c.id]||'').join('')}</div>`);
  }
  logList.innerHTML = parts.join('');

  if (shouldAnchorBootHead || scrollMode === 'top') {
    logList.scrollTop = 0;
  } else if (scrollMode === 'older') {
    logList.scrollTop = prevScrollTop + (logList.scrollHeight - prevScrollHeight);
  } else if (scrollMode === 'keep' && autoScroll.checked && wasAtBottom) {
    logList.scrollTop = logList.scrollHeight;
  } else {
    logList.scrollTop = prevScrollTop;
  }
  _lastRenderFilter = rawFilter;
  _lastRenderIp = currentIp;
  updateJumpEndBtn();
}

function isAtBottom() {
  return logList.scrollHeight - logList.scrollTop <= logList.clientHeight + 8;
}

function updateJumpEndBtn() {
  jumpEndBtn.style.display = currentIp && (nextAfter != null || !isAtBottom()) ? '' : 'none';
}

jumpEndBtn.addEventListener('click', async () => {
  autoScroll.checked = true;
  if (nextAfter != null) await jumpToTail();
  else logList.scrollTop = logList.scrollHeight;
  updateJumpEndBtn();
});

let _loadingOlder = false;
let _loadingNewer = false;
logList.addEventListener('scroll', async () => {
  updateJumpEndBtn();
  if (!_loadingOlder && nextBefore != null && logList.scrollTop <= 80) {
    _loadingOlder = true;
    try { await fetchLogs({ before: nextBefore, mode: 'older' }); }
    finally { _loadingOlder = false; }
    return;
  }
  if (!_loadingNewer && nextAfter != null &&
      logList.scrollHeight - logList.scrollTop - logList.clientHeight <= 80) {
    _loadingNewer = true;
    try { await fetchLogs({ from: nextAfter, mode: 'newer' }); }
    finally { _loadingNewer = false; }
  }
});

loadOlderBtn.addEventListener('click', () => {
  if (nextBefore != null) fetchLogs({ before: nextBefore, mode: 'older' });
});

purgeBtn.addEventListener('click', async () => {
  if (!currentIp) return;
  if (!confirm(`Purge all logs for ${currentIp}?`)) return;
  await fetch(`${BASE}/api/v1/logs?ip=${encodeURIComponent(currentIp)}`, { method: 'DELETE' });
  allRows = [];
  logList.innerHTML = '<div class="empty">Logs purged</div>';
  await loadSources();
});

filterInput.addEventListener('input', () => { renderLogs(); updateBootNavButtons(); });
document.getElementById('context-input').addEventListener('input', () => { renderLogs(); updateBootNavButtons(); });

document.getElementById('raw-mode-toggle').addEventListener('change', () => { updateGridTemplate(); renderLogs(); updateBootNavButtons(); });
document.getElementById('sort-device-time').addEventListener('change', () => { renderLogs(); updateBootNavButtons(); });

function hasBootFilter() {
  return /(?:^|\s)boot:-?\d+(?:\s|$)/i.test(filterInput.value.trim());
}

function updateBootNavButtons() {
  const show = currentIp != null;
  bootPrevBtn.style.display = show ? '' : 'none';
  bootNextBtn.style.display = show ? '' : 'none';
  bootPickerBtn.style.display = show ? '' : 'none';
}

const bootPickerBtn = document.getElementById('boot-picker-btn');
const bootPickerEl  = document.getElementById('boot-picker');

function fmtBootTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString('en-CA') + ' ' + d.toLocaleTimeString('en', { hour12: false });
}

async function openBootPicker() {
  if (!currentIp) return;
  bootPickerEl.innerHTML = '<div class="empty" style="padding:12px">Loading…</div>';
  bootPickerEl.classList.add('open');
  let items;
  try {
    ({ items } = await fetchJson(`${BASE}/api/v1/boots?ip=${encodeURIComponent(currentIp)}`));
  } catch (e) {
    bootPickerEl.innerHTML = `<div class="empty" style="padding:12px">Error: ${escHtml(e.message)}</div>`;
    return;
  }
  if (!items.length) {
    bootPickerEl.innerHTML = '<div class="empty" style="padding:12px">No boots recorded</div>';
    return;
  }
  // highlight boots that are part of the loaded window
  const visibleBoots = new Set(allRows.map(r => r.boot));
  bootPickerEl.innerHTML =
    '<div class="boot-hdr"><span>Boot</span><span>First entry</span><span>Last entry</span><span style="text-align:right">Entries</span><span></span></div>' +
    items.map(b =>
      `<div class="boot-item${visibleBoots.has(b.boot) ? ' current' : ''}" data-first="${b.firstId}" title="Jump to start of boot ${b.boot}">` +
        `<span class="boot-no">&#x21bb; ${b.boot}</span>` +
        `<span class="boot-time">${fmtBootTime(b.startedAt)}</span>` +
        `<span class="boot-time">${fmtBootTime(b.endedAt)}</span>` +
        `<span class="boot-entries">${b.entries}</span>` +
        `<span class="boot-crash" title="${b.crashes} crash dump(s)">${b.crashes ? '&#9888;' : ''}</span>` +
      `</div>`
    ).join('');
  bootPickerEl.querySelectorAll('.boot-item').forEach(el => {
    el.addEventListener('click', async () => {
      bootPickerEl.classList.remove('open');
      await fetchLogs({ from: Number(el.dataset.first), mode: 'jump' });
    });
  });
}

bootPickerBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  if (bootPickerEl.classList.contains('open')) { bootPickerEl.classList.remove('open'); return; }
  openBootPicker();
});
document.addEventListener('click', (e) => {
  if (!bootPickerEl.contains(e.target) && e.target !== bootPickerBtn) bootPickerEl.classList.remove('open');
});

async function jumpToTail() {
  allRows = [];
  nextBefore = null;
  nextAfter = null;
  await fetchLogs();
  logList.scrollTop = logList.scrollHeight;
}

// Server-side jump for boot boundaries outside the loaded window.
async function jumpToBoot(direction) {
  if (!currentIp || !allRows.length) return;
  const ref = direction === 'prev' ? allRows[0] : allRows[allRows.length - 1];
  if (ref.id == null) return;

  try {
    const data = await fetchJson(
      `${BASE}/api/v1/logs/boot-jump?ip=${encodeURIComponent(currentIp)}` +
      `&currentId=${ref.id}&direction=${direction}`
    );
    if (data.targetId != null) {
      await fetchLogs({ from: data.targetId, mode: 'jump' });
    } else if (direction === 'next') {
      if (nextAfter != null) await jumpToTail();
      else logList.scrollTop = logList.scrollHeight;
    } else {
      logList.scrollTop = 0;
    }
  } catch (e) {
    console.error('Failed to jump to boot boundary:', e);
  }
}

bootPrevBtn.addEventListener('click', async () => {
  if (hasBootFilter()) {
    logList.scrollTop = 0;
    return;
  }
  const markers = [...logList.querySelectorAll('.reboot-marker')];
  const threshold = logList.scrollTop - 4;
  const target = markers.reverse().find(m => m.offsetTop < threshold);
  if (target) {
    logList.scrollTop = Math.max(0, target.offsetTop);
    return;
  }
  await jumpToBoot('prev');
});

bootNextBtn.addEventListener('click', async () => {
  if (hasBootFilter()) {
    logList.scrollTop = logList.scrollHeight;
    return;
  }
  const markers = [...logList.querySelectorAll('.reboot-marker')];
  const threshold = logList.scrollTop + 4;
  const target = markers.find(m => m.offsetTop > threshold);
  if (target) {
    logList.scrollTop = Math.max(0, target.offsetTop);
    return;
  }
  await jumpToBoot('next');
});

const colPickerBtn = document.getElementById('col-picker-btn');
const colPickerEl  = document.getElementById('col-picker');
colPickerBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  if (colPickerEl.classList.contains('open')) { colPickerEl.classList.remove('open'); return; }
  colPickerEl.innerHTML = columns.map(c =>
    `<label><input type="checkbox" data-col="${c.id}" ${c.visible ? 'checked' : ''} />${escHtml(c.label)}</label>`
  ).join('');
  colPickerEl.querySelectorAll('input[type=checkbox]').forEach(cb => {
    cb.addEventListener('change', () => {
      const col = columns.find(c => c.id === cb.dataset.col);
      if (col) { col.visible = cb.checked; updateGridTemplate(); renderLogs(); saveColState(); }
    });
  });
  colPickerEl.classList.add('open');
});
document.addEventListener('click', (e) => {
  if (!colPickerEl.contains(e.target) && e.target !== colPickerBtn) colPickerEl.classList.remove('open');
});

autoRefresh.addEventListener('change', () => {
  clearInterval(refreshTimer);
  if (autoRefresh.checked) {
    refreshTimer = setInterval(async () => { await loadSources(); if (currentIp) await fetchLogs(); }, 5000);
  }
});

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
    const active = document.activeElement;
    if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.tagName === 'SELECT')) return;
    e.preventDefault();
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(logList);
    sel.removeAllRanges();
    sel.addRange(range);
  }
});

loadColState();
updateGridTemplate();
loadSources();
fetchLogs();
window.fetchLogs = fetchLogs;
refreshTimer = setInterval(async () => { await loadSources(); if (currentIp) await fetchLogs(); }, 5000);

logList.addEventListener('click', (e) => {
  const btn = e.target.closest('.crash-btn');
  if (btn) {
    const id = Number(btn.dataset.id);
    if (id) handleCrashBtnClick(id, allRows, currentIp);
  }
});

export { selectSource, fetchLogs, loadSources };
export const getCurrentIp = () => currentIp;
export const getRows = () => allRows;
