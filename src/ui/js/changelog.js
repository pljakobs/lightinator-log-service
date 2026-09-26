import { BASE, fetchJson, escHtml } from './common.js';

let _loaded = false;

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('en', { year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
}

function renderBuild(b, currentBuild) {
  const isCurrent = b.build === currentBuild;
  const meta = [fmtDate(b.date), b.gitVersion].filter(Boolean).map(escHtml).join(' · ');
  const commits = (b.commits || []).length
    ? `<ul class="cl-commits">${b.commits.map(c =>
      `<li class="cl-commit"><span class="cl-sha" title="${escHtml(c.sha || '')}">${escHtml(c.short || '')}</span><span class="cl-subject">${escHtml(c.subject || '')}</span></li>`,
    ).join('')}</ul>`
    : '<div class="cl-none">No changes recorded</div>';
  return `<div class="cl-build${isCurrent ? ' current' : ''}" data-build="${escHtml(b.build)}">
    <div class="cl-build-header">
      <span>Build #${escHtml(b.build)}</span>
      ${meta ? `<span class="cl-build-meta">· ${meta}</span>` : ''}
      ${isCurrent ? '<span class="cl-current-tag">current</span>' : ''}
    </div>
    ${commits}
  </div>`;
}

async function loadChangelog() {
  const body = document.getElementById('changelog-body');
  const meta = document.getElementById('changelog-meta');
  try {
    const data = await fetchJson(`${BASE}/api/v1/changelog`);
    const builds = Array.isArray(data.builds) ? data.builds : [];
    meta.textContent = data.buildNumber ? `Build #${data.buildNumber} · ${data.gitVersion || ''}` : '';
    if (!builds.length) {
      body.innerHTML = '<div class="empty">No changelog available in this build</div>';
      return;
    }
    // current build first, then the rest in the order delivered (newest first)
    const current = String(data.buildNumber || '');
    const ordered = [...builds.filter(b => b.build === current), ...builds.filter(b => b.build !== current)];
    body.innerHTML = ordered.map(b => renderBuild(b, current)).join('');
    _loaded = true;
  } catch (err) {
    body.innerHTML = `<div class="empty">Could not load changelog: ${escHtml(err.message)}</div>`;
  }
}

function openChangelog() {
  document.getElementById('changelog-overlay').classList.add('open');
  if (!_loaded) loadChangelog();
}

function closeChangelog() {
  document.getElementById('changelog-overlay').classList.remove('open');
}

const badge = document.getElementById('build-info');
badge.addEventListener('click', openChangelog);
badge.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openChangelog(); }
});
document.getElementById('changelog-close-btn').addEventListener('click', closeChangelog);
document.getElementById('changelog-overlay').addEventListener('click', (e) => {
  if (e.target === document.getElementById('changelog-overlay')) closeChangelog();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && document.getElementById('changelog-overlay').classList.contains('open')) {
    closeChangelog();
  }
});

export { openChangelog, closeChangelog };
