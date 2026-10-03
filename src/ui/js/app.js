import { BASE, fetchJson, activateTab, setSourceDrawer } from './common.js';
import './logs.js';
import './controllers.js';
import './crashes.js';
import './settings.js';
import './search.js';
import './changelog.js';

fetch('/api/info')
  .then(res => res.json())
  .then(data => {
    if (data.buildNumber) {
      document.getElementById('build-info').textContent = `Build #${data.buildNumber}`;
      document.getElementById('build-info').title = `Version: ${data.gitVersion || 'unknown'} — click for what's new`;
    }
  })
  .catch(() => {});

async function pollLokiStatus() {
  const dot = document.getElementById('loki-dot');
  try {
    const s = await fetchJson(`${BASE}/api/v1/loki/status`);
    if (s.state === 'ok') {
      const ago = s.lastPushAt ? new Date(s.lastPushAt).toLocaleTimeString('en', {hour12:false}) : '';
      dot.style.color = '#4ec9b0';
      dot.title = `Loki: OK — last push ${ago} (${s.pushed} entries total)`;
    } else if (s.state === 'error') {
      dot.style.color = '#f48771';
      dot.title = `Loki: error — ${s.lastError}`;
    } else {
      dot.style.color = '#555';
      dot.title = 'Loki: forwarding disabled';
    }
  } catch {
    dot.style.color = '#555';
    dot.title = 'Loki: status unavailable';
  }
}
pollLokiStatus();
setInterval(pollLokiStatus, 15000);

document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => activateTab(tab.dataset.tab));
});

const sourcePanel = document.getElementById('sources-panel');
document.getElementById('sources-toggle').addEventListener('click', () => setSourceDrawer(!sourcePanel.classList.contains('drawer-open')));
document.getElementById('sources-close').addEventListener('click', () => setSourceDrawer(false));
document.getElementById('sources-backdrop').addEventListener('click', () => setSourceDrawer(false));
window.matchMedia('(max-width: 900px)').addEventListener('change', () => setSourceDrawer(false));
document.addEventListener('keydown', event => {
  if (!sourcePanel.classList.contains('drawer-open')) return;
  if (event.key === 'Escape') setSourceDrawer(false);
  if (event.key === 'Tab') {
    const buttons = [...sourcePanel.querySelectorAll('button')].filter(button => !button.disabled);
    const first = buttons[0];
    const last = buttons[buttons.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }
});
setSourceDrawer(false);
