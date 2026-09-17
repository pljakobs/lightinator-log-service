import { AnsiUp } from 'https://cdn.jsdelivr.net/npm/ansi_up@6.0.2/+esm';

export const ansi_up = new AnsiUp();
ansi_up.use_classes = true;

export const BASE = '';

export async function fetchJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

export function severityClass(priority) {
  if (priority == null) return '';
  const sev = priority & 7;
  if (sev <= 3) return 'err';
  if (sev === 4) return 'warn';
  return '';
}

export function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

export function timeAgo(isoString) {
  if (!isoString) return 'never';
  const diffMs = Date.now() - new Date(isoString).getTime();
  if (diffMs < 0) return 'just now';
  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 30) return 'just now';
  if (seconds < 60) return 'within one minute';
  const minutes = Math.floor(seconds / 60);
  if (minutes === 1) return '1 minute ago';
  if (minutes < 60) return minutes + ' minutes ago';
  const hours = Math.floor(minutes / 60);
  if (hours === 1) return '1 hour ago';
  if (hours < 24) return hours + ' hours ago';
  const days = Math.floor(hours / 24);
  if (days === 1) return '1 day ago';
  return days + ' days ago';
}

export function fmtLogTime(iso) {
  return iso ? new Date(iso).toLocaleTimeString('en', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3 }) : '';
}

/** Switch main tab; other modules react via the 'tabchange' event on document. */
export function activateTab(name) {
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  document.getElementById('log-panel').style.display = name === 'logs' ? 'flex' : 'none';
  document.getElementById('controllers-panel').classList.toggle('visible', name === 'controllers');
  document.getElementById('crashes-panel').classList.toggle('visible', name === 'crashes');
  document.getElementById('search-panel').classList.toggle('visible', name === 'search');
  document.dispatchEvent(new CustomEvent('tabchange', { detail: name }));
}

export function currentTab() {
  return document.querySelector('.tab.active')?.dataset.tab || 'logs';
}
