'use strict';
// Renders the Claude Code status line:
//   hour 312k · today 2.4M · week 6.6M
//   5h ████████░░ 78% resets 1h42m │ week ████░░░░░░ 41% resets 3d6h
//   ⚠ burn rate high — at this pace you hit the 5h limit in ~38m      (only when needed)
const { getState } = require('./state');
const snapshots = require('./snapshots');
const alerts = require('./alerts');
const { c, bar, fmtTok, fmtDur, fmtUsd, levelColor, setColorMode } = require('./util');

function tokenLine(st) {
  const { tokens, budget } = st;
  const todayColor = budget.daily ? levelColor(budget.daily.pct, { warnPct: 80, dangerPct: 100 }) : 'w';
  const weekColor = budget.weekly ? levelColor(budget.weekly.pct, { warnPct: 80, dangerPct: 100 }) : 'w';
  const parts = [
    `hour ${c('w', fmtTok(tokens.hour))}`,
    `today ${c(todayColor === 'g' ? 'w' : todayColor, fmtTok(tokens.today))}`,
    `week ${c(weekColor === 'g' ? 'w' : weekColor, fmtTok(tokens.week))}`
  ];
  if (budget.daily && budget.daily.pct >= 80) parts[1] += c('d', `/${fmtTok(budget.daily.limit)}`);
  return parts.join(c('d', ' · '));
}

function limitsLine(st) {
  const { snap, now, cfg } = st;
  const out = [];
  if (snap && snap.f != null) {
    const col = levelColor(snap.f, cfg);
    out.push(`5h ${bar(snap.f, 10, col)} ${c(col, Math.round(snap.f) + '%')} ${c('d', 'resets ' + fmtDur(snap.fr - now))}`);
  }
  if (snap && snap.w != null) {
    const col = levelColor(snap.w, cfg);
    out.push(`week ${bar(snap.w, 10, col)} ${c(col, Math.round(snap.w) + '%')} ${c('d', 'resets ' + fmtDur(snap.wr - now))}`);
  }
  if (out.length) return out.join(c('d', '  │  '));
  // API-key users (no subscription limits): show context and session cost instead.
  const extra = [];
  if (snap && snap.c != null) extra.push(`ctx ${bar(snap.c, 8, levelColor(snap.c, { warnPct: 60, dangerPct: 85 }))} ${Math.round(snap.c)}%`);
  if (snap && snap.usd != null) extra.push(`session ${c('w', fmtUsd(snap.usd))} ${c('d', '(est.)')}`);
  return extra.join(c('d', '  │  '));
}

function warningLine(st) {
  const { snap, burn, now, cfg, budget, tip } = st;
  if (snap && snap.f != null) {
    if (snap.f >= cfg.dangerPct) {
      const left = burn && burn.minsToFull != null
        ? `~${fmtDur(burn.minsToFull * 60000)} left at this pace`
        : `5h at ${Math.round(snap.f)}%, resets in ${fmtDur(snap.fr - now)}`;
      return c('r', `⚠ ${left} — ${tip}`);
    }
    if (burn && burn.willHit && snap.f >= 50) {
      return c('y', `⚠ burn rate high — at this pace you hit the 5h limit in ~${fmtDur(burn.minsToFull * 60000)}`);
    }
  }
  if (snap && snap.w != null && snap.w >= cfg.dangerPct) {
    return c('r', `⚠ weekly limit at ${Math.round(snap.w)}% — resets in ${fmtDur(snap.wr - now)}. ${tip}`);
  }
  if (budget.daily && budget.daily.pct >= 100) return c('y', `⚠ daily budget of ${fmtTok(budget.daily.limit)} reached`);
  if (budget.weekly && budget.weekly.pct >= 100) return c('y', `⚠ weekly budget of ${fmtTok(budget.weekly.limit)} reached`);
  return null;
}

function render(st) {
  return [tokenLine(st), limitsLine(st), warningLine(st)].filter(Boolean).join('\n');
}

function readStdin(timeoutMs = 1000) {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('');
    let data = '';
    const timer = setTimeout(() => resolve(data), timeoutMs);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => { data += d; });
    process.stdin.on('end', () => { clearTimeout(timer); resolve(data); });
    process.stdin.on('error', () => { clearTimeout(timer); resolve(data); });
  });
}

async function main() {
  setColorMode(process.env.NO_COLOR ? 'none' : 'ansi');
  let input = {};
  try { input = JSON.parse((await readStdin()) || '{}'); } catch { input = {}; }
  let st;
  try {
    st = getState({ input });
  } catch (e) {
    process.stdout.write('pacr: ' + (e && e.message ? e.message : 'error') + '\n');
    return;
  }
  process.stdout.write(render(st) + '\n');
  // Save the snapshot and check alerts after printing, so the status line shows up fast.
  try { if (st.snap && (st.snap.f != null || st.snap.w != null || st.snap.c != null)) snapshots.record(st.snap); } catch { /* ignore */ }
  try { alerts.evaluate(st); } catch { /* ignore */ }
}

module.exports = { main, render, tokenLine, limitsLine, warningLine };
