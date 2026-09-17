import { BASE, fetchJson, escHtml, severityClass, fmtLogTime } from './common.js';
import { selectSource } from './logs.js';
import { handleCrashBtnClick } from './crash.js';

const searchQueryEl  = document.getElementById('search-query');
const searchCtxEl    = document.getElementById('search-context-n');
const searchLimitEl  = document.getElementById('search-limit-sel');
const searchBtnEl    = document.getElementById('search-btn');
const searchStatusEl = document.getElementById('search-status');
const searchResultsEl = document.getElementById('search-results');

async function runSearch() {
  const q = (searchQueryEl.value || '').trim();
  if (!q) return;
  searchBtnEl.disabled = true;
  searchStatusEl.textContent = 'Searching…';
  searchResultsEl.innerHTML = '';
  try {
    const limit   = searchLimitEl.value;
    const context = searchCtxEl.value;
    const data = await fetchJson(`${BASE}/api/v1/search?q=${encodeURIComponent(q)}&limit=${limit}&context=${context}`);
    renderSearchResults(data, q);
    const ipCount = new Set(data.snippets.map(s => s.ip)).size;
    searchStatusEl.textContent = data.total === 0
      ? 'No matches'
      : `${data.total} match${data.total !== 1 ? 'es' : ''} across ${ipCount} controller${ipCount !== 1 ? 's' : ''}`;
  } catch (e) {
    searchStatusEl.textContent = 'Error: ' + e.message;
  } finally {
    searchBtnEl.disabled = false;
  }
}

function markMatch(text, q) {
  if (!q || !text) return escHtml(text || '');
  const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
  const parts = [];
  let lastIdx = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    parts.push(escHtml(text.slice(lastIdx, m.index)));
    parts.push('<mark>' + escHtml(m[0]) + '</mark>');
    lastIdx = m.index + m[0].length;
  }
  parts.push(escHtml(text.slice(lastIdx)));
  return parts.join('');
}

function renderSearchResults(data, q) {
  if (!data.snippets || !data.snippets.length) {
    searchResultsEl.innerHTML = '<div class="empty">No matches found</div>';
    return;
  }
  const groups = new Map();
  for (const s of data.snippets) {
    if (!groups.has(s.ip)) groups.set(s.ip, []);
    groups.get(s.ip).push(s);
  }
  const parts = [];
  for (const [ip, snippets] of groups) {
    const matchCount = snippets.length;
    parts.push(`<div class="search-group-hdr"><span class="search-ip">${escHtml(ip)}</span><span style="color:#555">&middot;</span><span>${matchCount} match${matchCount !== 1 ? 'es' : ''}</span><button class="src-link" data-ip="${escHtml(ip)}" style="margin-left:auto;font-size:11px;background:#3c3c3c;padding:2px 8px">View logs</button></div>`);
    for (let si = 0; si < snippets.length; si++) {
      const snip = snippets[si];
      if (si > 0) parts.push('<div class="search-sep">&hellip;</div>');
      for (const r of snip.rows) {
        const cls = severityClass(r.priority);
        const matchCls = r._match ? ' search-match' : ' context';
        const time = fmtLogTime(r.receivedAt);
        const isPending = r.crashDecode && r.crashDecode.includes('decoding in progress');
        const crashBtn = r.crashDecode ? `<button class="crash-btn${isPending ? ' pending' : ''}" data-id="${r.id}" title="${isPending ? 'Crash decode in progress…' : 'Click to view decoded stack trace'}">${isPending ? '&#x23F3; Decoding Crash…' : '&#x1F50D; View Crash Decode'}</button>` : '';
        const msgHtml = r._match ? markMatch(r.message || r.raw || '', q) : escHtml(r.message || r.raw || '');
        parts.push(`<div class="log-row${cls ? ' '+cls : ''}${matchCls}">` +
          `<span class="col-time">${time}</span>` +
          `<span class="col-tag" title="${escHtml(r.tag||'')}">${escHtml(r.tag||'')}</span>` +
          `<span class="col-app" title="${escHtml(r.app||'')}">${escHtml(r.app||'')}</span>` +
          `<span class="col-msg">${crashBtn}${msgHtml}</span>` +
          `</div>`);
      }
    }
  }
  searchResultsEl.innerHTML = parts.join('');
  searchResultsEl.querySelectorAll('.src-link').forEach(btn => {
    btn.addEventListener('click', () => {
      selectSource(btn.dataset.ip);
    });
  });
}

searchBtnEl.addEventListener('click', runSearch);
searchQueryEl.addEventListener('keydown', e => { if (e.key === 'Enter') runSearch(); });

document.getElementById('search-results').addEventListener('click', (e) => {
  const btn = e.target.closest('.crash-btn');
  if (btn) {
    const id = Number(btn.dataset.id);
    if (id) handleCrashBtnClick(id);
  }
});

document.addEventListener('tabchange', (e) => { if (e.detail === 'search') searchQueryEl.focus(); });
