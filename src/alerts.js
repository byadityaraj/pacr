'use strict';
// Threshold alerts. Each alert fires once per window/day/session, is written to
// ~/.pacr/alerts.jsonl (the VS Code extension shows new entries) and, if enabled,
// sent as a desktop notification.
const path = require('path');
const { spawn } = require('child_process');
const { file } = require('./paths');
const { readJSON, writeJSON, appendJSONL, readJSONL, pruneJSONL } = require('./store');
const notify = require('./notify');
const snapshots = require('./snapshots');
const { fmtTok, fmtDur, fmtPct, dayKey, startOfWeek, DAY } = require('./util');

function loadState() { return readJSON(file('alert-state.json'), { fired: {}, maxed: {} }); }

function fire(st, cfg, key, level, title, msg, now) {
  if (st.fired[key]) return false;
  st.fired[key] = now;
  appendJSONL(file('alerts.jsonl'), { t: now, key, level, title, msg });
  if (cfg.notify && cfg.notify.enabled) notify.send(title, msg);
  return true;
}

// Runs the weekly summary in a separate process so the status line never waits for it.
function spawnSummary(inline) {
  if (inline) {
    setTimeout(() => { try { require('./reports').summaryNotify(); } catch { /* ignore */ } }, 2000);
    return;
  }
  try {
    const bin = path.join(__dirname, '..', 'bin', 'pacr.js');
    // ELECTRON_RUN_AS_NODE makes this work when the host process is VS Code, not node.
    const p = spawn(process.execPath, [bin, 'summary', '--notify'], {
      detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
    });
    p.on('error', () => {});
    p.unref();
  } catch { /* ignore */ }
}

function evaluate(state, { allowSummary = true, inlineSummary = false, desktop = true } = {}) {
  const { cfg, snap, burn, tokens, now } = state;
  const n = cfg.notify || {};
  const st = loadState();
  const fired = [];
  const fcfg = desktop ? cfg : { ...cfg, notify: { ...n, enabled: false } };
  const add = (...a) => { if (fire(st, fcfg, ...a, now)) fired.push(a[0]); };

  // Ignore stale snapshots (older than 15 min) for threshold alerts.
  // Skip numbers the status line hasn't refreshed for a while (snapAgeMs counts from the last reply instead).
  const fresh = snap && (state.snapAgeMs == null || state.now - snap.t < 15 * 60000);

  if (fresh && snap.f != null && snap.fr != null) {
    const id = snapshots.winId(snap.fr);
    for (const p of [].concat(n.fiveHour || [])) {
      if (snap.f >= p) add(`5h:${p}:${id}`, p >= cfg.dangerPct ? 'danger' : 'warn',
        `5-hour limit at ${fmtPct(snap.f)}`, `Resets in ${fmtDur(snap.fr - now)}. ${state.tip || ''}`.trim());
    }
    if (n.burnRate && burn && burn.willHit && burn.minsToFull <= (n.burnMinutes || 45) && snap.f >= 50) {
      add(`burn:${id}`, 'warn', 'Burn rate high',
        `At this pace you hit the 5-hour limit in ~${fmtDur(burn.minsToFull * 60000)} (resets in ${fmtDur(snap.fr - now)}). ${state.tip || ''}`.trim());
    }
    if (snap.f >= snapshots.HIT_PCT) st.maxed.f = snap.fr;
  }
  if (fresh && snap.w != null && snap.wr != null) {
    const id = snapshots.winId(snap.wr);
    for (const p of [].concat(n.weekly || [])) {
      if (snap.w >= p) add(`wk:${p}:${id}`, p >= cfg.dangerPct ? 'danger' : 'warn',
        `Weekly limit at ${fmtPct(snap.w)}`, `Resets in ${fmtDur(snap.wr - now)}.`);
    }
    if (snap.w >= snapshots.HIT_PCT) st.maxed.w = snap.wr;
  }

  // Reset ready: a window you maxed out has reset (works even from a stale snapshot).
  if (n.resetReady) {
    if (st.maxed.f && now >= st.maxed.f) {
      add(`reset5h:${snapshots.winId(st.maxed.f)}`, 'info', '5-hour window reset', "You're good to go.");
      delete st.maxed.f;
    }
    if (st.maxed.w && now >= st.maxed.w) {
      add(`resetwk:${snapshots.winId(st.maxed.w)}`, 'info', 'Weekly limit reset', "You're good to go.");
      delete st.maxed.w;
    }
  }

  // Your own budgets.
  if (n.budget && state.budget) {
    const d = state.budget.daily;
    if (d) {
      const k = dayKey(now);
      if (d.pct >= 100) add(`bd100:${k}`, 'danger', 'Daily token budget reached', `${fmtTok(d.used)} of ${fmtTok(d.limit)} today.`);
      else if (d.pct >= 80) add(`bd80:${k}`, 'warn', 'Daily budget at 80%', `${fmtTok(d.used)} of ${fmtTok(d.limit)} today.`);
    }
    const w = state.budget.weekly;
    if (w) {
      const k = dayKey(snap && snap.wr ? snap.wr : startOfWeek(now));
      if (w.pct >= 100) add(`bw100:${k}`, 'danger', 'Weekly token budget reached', `${fmtTok(w.used)} of ${fmtTok(w.limit)} this week.`);
      else if (w.pct >= 80) add(`bw80:${k}`, 'warn', 'Weekly budget at 80%', `${fmtTok(w.used)} of ${fmtTok(w.limit)} this week.`);
    }
  }

  // One expensive session.
  if (fresh && n.sessionCostUsd && snap.usd != null && snap.sid && snap.usd >= n.sessionCostUsd) {
    add(`sess:${snap.sid}`, 'warn', `Session passed $${n.sessionCostUsd} (est.)`,
      `This session: ${tokens && tokens.session ? fmtTok(tokens.session) + ' tokens, ' : ''}~$${snap.usd.toFixed(2)}. ${state.tip || ''}`.trim());
  }

  // Weekly summary, once per week from Monday on, if there was usage last week.
  if (allowSummary && n.weeklySummary) {
    const k = `sum:${dayKey(startOfWeek(now))}`;
    if (!st.fired[k]) {
      st.fired[k] = now;
      spawnSummary(inlineSummary);
    }
  }

  // Forget old keys.
  for (const k of Object.keys(st.fired)) if (now - st.fired[k] > 30 * DAY) delete st.fired[k];
  writeJSON(file('alert-state.json'), st);
  pruneJSONL(file('alerts.jsonl'), 't', 60 * DAY, 512 * 1024);
  return fired;
}

function recent(limit = 10) {
  return readJSONL(file('alerts.jsonl')).sort((a, b) => b.t - a.t).slice(0, limit);
}

// Record an alert without threshold logic (used by the weekly summary).
function push(cfg, key, level, title, msg) {
  const st = loadState();
  const now = Date.now();
  st.fired[key] = 0;
  delete st.fired[key];
  fire(st, cfg, key, level, title, msg, now);
  writeJSON(file('alert-state.json'), st);
}

module.exports = { evaluate, recent, push };
