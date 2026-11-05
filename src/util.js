'use strict';

// ---------- color output (ansi for terminals, html for the VS Code panel, none for pipes) ----------
let MODE = 'ansi';
const ANSI = { g: 32, y: 33, r: 31, d: 90, b: 34, c: 36, m: 35, w: 1, bold: 1 };
const HTML = { g: 'g', y: 'y', r: 'r', d: 'd', b: 'b', c: 'c', m: 'm', w: 'w', bold: 'w' };

function setColorMode(m) { MODE = m; }
function colorMode() { return MODE; }

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function c(color, text) {
  text = String(text);
  if (!color || MODE === 'none') return MODE === 'html' ? esc(text) : text;
  if (MODE === 'html') return `<span class="${HTML[color] || color}">${esc(text)}</span>`;
  return `\x1b[${ANSI[color]}m${text}\x1b[0m`;
}

// Plain text that must be escaped in html mode (use for any user/log-derived strings).
function t(text) { return MODE === 'html' ? esc(text) : String(text); }

function visibleLen(s) {
  return String(s).replace(/\x1b\[[0-9;]*m/g, '').replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').length;
}
function padEnd(s, n) { const l = visibleLen(s); return l >= n ? s : s + ' '.repeat(n - l); }
function padStart(s, n) { const l = visibleLen(s); return l >= n ? s : ' '.repeat(n - l) + s; }

// ---------- number / time formatting ----------
function fmtTok(n) {
  n = Math.round(n || 0);
  if (n < 1000) return String(n);
  if (n < 10000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  if (n < 999500) return Math.round(n / 1000) + 'k';
  if (n < 1e7) return (n / 1e6).toFixed(2).replace(/0$/, '').replace(/\.0$/, '') + 'M';
  if (n < 1e9) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  return (n / 1e9).toFixed(2) + 'B';
}

function parseTok(s) {
  if (s == null) return null;
  const m = String(s).trim().toLowerCase().match(/^([\d.]+)\s*([kmb])?$/);
  if (!m) return null;
  const mult = { k: 1e3, m: 1e6, b: 1e9 }[m[2]] || 1;
  return Math.round(parseFloat(m[1]) * mult);
}

function fmtDur(ms) {
  if (ms == null || !isFinite(ms)) return '?';
  if (ms < 0) ms = 0;
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h${String(m % 60).padStart(2, '0')}m`;
  const d = Math.floor(h / 24);
  return `${d}d${h % 24}h`;
}

function fmtUsd(v) { return v == null ? '—' : '$' + v.toFixed(2); }
// One decimal under 10% (1.4%) when the value has one; whole numbers otherwise.
function fmtPct(v) {
  if (v == null || !isFinite(v)) return '—';
  const d = Math.round(v * 10) / 10;
  return d < 10 && d !== Math.round(d) ? `${d.toFixed(1)}%` : `${Math.round(v)}%`;
}

function bar(pct, width, color) {
  pct = Math.max(0, Math.min(100, pct || 0));
  const f = Math.round((pct / 100) * width);
  return c(color, '█'.repeat(f)) + c('d', '░'.repeat(width - f));
}

function levelColor(pct, cfg) {
  if (pct == null) return 'd';
  if (pct >= cfg.dangerPct) return 'r';
  if (pct >= cfg.warnPct) return 'y';
  return 'g';
}

// ---------- dates (local time) ----------
const DAY = 86400000;
const HOUR = 3600000;
function startOfDay(ts) { const d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime(); }
function startOfHour(ts) { const d = new Date(ts); d.setMinutes(0, 0, 0); return d.getTime(); }
// Monday-based week start.
function startOfWeek(ts) {
  const d = new Date(startOfDay(ts));
  const dow = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - dow);
  return d.getTime();
}
function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function fmtDay(ts) { const d = new Date(ts); return `${DOW[d.getDay()]} ${MON[d.getMonth()]} ${d.getDate()}`; }
function fmtHM(ts) { const d = new Date(ts); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; }

function parseDateArg(s) {
  const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  return new Date(+m[1], +m[2] - 1, +m[3]).getTime();
}

function shortId(id) { return String(id || '').slice(0, 6); }
function projName(p) {
  if (!p) return '?';
  const parts = String(p).split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || p;
}

// ---------- simple table ----------
function table(headers, rows, aligns = []) {
  const widths = headers.map((h, i) => Math.max(visibleLen(h), ...rows.map((r) => visibleLen(r[i] ?? ''))));
  const fmt = (cells, isHead) => cells.map((cell, i) => {
    const s = cell ?? '';
    const v = aligns[i] === 'r' ? padStart(s, widths[i]) : padEnd(s, widths[i]);
    return isHead ? c('d', MODE === 'html' ? v.replace(/<[^>]+>/g, '') : v.replace(/\x1b\[[0-9;]*m/g, '')) : v;
  }).join('  ').replace(/\s+$/, '');
  return [fmt(headers, true), ...rows.map((r) => fmt(r, false))].join('\n');
}

module.exports = {
  setColorMode, colorMode, c, t, esc, visibleLen, padEnd, padStart,
  fmtTok, parseTok, fmtDur, fmtUsd, fmtPct, bar, levelColor,
  DAY, HOUR, startOfDay, startOfHour, startOfWeek, dayKey, fmtDay, fmtHM, parseDateArg, DOW,
  shortId, projName, table
};
