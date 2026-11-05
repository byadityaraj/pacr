'use strict';
// Estimates the decimal of the limit % that Claude Code passes as a whole number.
// Claude Code appears to drop the decimal (2.7% → 2%), while claude.ai rounds (→ 3%).
// When the whole number goes up (2 → 3), the real value was ~3.0% at that moment. Tokens between two
// such steps give tokens per 1%, and tokens since the last step give the decimal. Tokens are weighted
// like API prices (logs.weighted), so cache reads count: fresh tokens alone read low in cache-heavy steps.
// Never more than 1% off: the estimate stays in [n, n + 0.99].
const path = require('path');
const { spawn } = require('child_process');
const { file } = require('./paths');
const { readJSON, writeJSON } = require('./store');
const logs = require('./logs');
const snapshots = require('./snapshots');
const { winId } = snapshots;

const KEYS = { f: { rkey: 'fr', len: 5 * 3600000 }, w: { rkey: 'wr', len: 7 * 86400000 } };
const KEEP_WINDOWS = 8;
const BACKFILL_MS = 8 * 86400000; // as far back as the rollup keeps tokens
const RETRY_MS = 10 * 60000;
const VERSION = 2; // 2 = weighted tokens (0.3.1); older state is in fresh tokens and is relearned

const avg = (a) => (a && a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);

// Weighted tokens since a fixed point of the window. Only differences are used, so buckets written
// before the weighted column existed (counted as 0) don't matter.
function windowTokens(roll, key, resetAt, now) {
  return logs.rollupWeighted(roll, resetAt - KEYS[key].len, now);
}

// One limit's state: {win, r, n, at, tok, rates, hist}
//   n = last whole number seen, at/tok = when it last went up and the window's tokens then,
//   rates = tokens per 1% in this window, hist = average tokens per 1% of earlier windows.
// Pure: returns the new state (the same object when nothing changed).
function observe(st, raw, resetAt, tok, now) {
  if (raw == null || resetAt == null || tok == null) return st;
  const win = winId(resetAt);
  if (!st || st.win !== win) {
    if (st && st.r != null && resetAt < st.r) return st; // a session still showing an older window
    const hist = st ? (st.hist || []).slice() : [];
    const a = st && avg(st.rates);
    if (a) hist.push(a);
    return { win, r: resetAt, n: raw, at: null, tok: null, rates: [], hist: hist.slice(-KEEP_WINDOWS) };
  }
  if (raw <= st.n) return st;
  const rates = st.rates.slice();
  if (st.at != null) {
    const rate = (tok - st.tok) / (raw - st.n);
    if (rate > 0) rates.push(rate);
  }
  return { ...st, n: raw, at: now, tok, rates };
}

// Pure: {raw, value, shown, approx, perPct} or null when there's nothing to estimate from.
function estimate(st, raw, resetAt, tok) {
  if (raw == null || resetAt == null || tok == null || !st) return null;
  if (st.win !== winId(resetAt) || st.n !== raw || st.at == null || raw >= 100) return null;
  const perPct = avg(st.rates) || avg(st.hist);
  if (!perPct) return null;
  const value = raw + Math.min(0.99, Math.max(0, (tok - st.tok) / perPct));
  const shown = Math.round(value); // claude.ai rounds
  return { raw, value: Math.round(value * 100) / 100, shown, approx: shown !== raw, perPct: Math.round(perPct) };
}

function load() {
  const all = readJSON(file('estimate.json'), {}) || {};
  return all.v === VERSION ? all : { v: VERSION };
}

// snap: merged snapshot. update: also record steps (only for fresh numbers from the status line).
function forSnap(snap, roll, now, update = false) {
  const out = { f: null, w: null };
  if (!snap) return out;
  const all = load();
  let changed = false;
  for (const key of Object.keys(KEYS)) {
    const resetAt = snap[KEYS[key].rkey];
    const raw = snap[key];
    if (raw == null || resetAt == null) continue;
    // A step is rare and its moment matters: make sure the reply that caused it is counted.
    const prev = all[key];
    if (update && prev && prev.win === winId(resetAt) && raw > prev.n) roll = logs.updateRollup({ minIntervalMs: 0, now });
    const tok = windowTokens(roll, key, resetAt, now);
    if (update) {
      const next = observe(all[key], raw, resetAt, tok, now);
      if (next !== all[key]) { all[key] = next; changed = true; }
    }
    out[key] = estimate(all[key], raw, resetAt, tok);
  }
  // First run: learn from the snapshots and logs pacr already has, in the background.
  if (update && !all.backfilled && !process.env.PACR_NO_BACKFILL && !(all.backfillStarted > now - RETRY_MS)) {
    all.backfillStarted = now;
    changed = true;
    spawnBackfill();
  }
  if (changed) { try { writeJSON(file('estimate.json'), all); } catch { /* ignore */ } }
  return out;
}

function spawnBackfill() {
  try {
    const bin = path.join(__dirname, '..', 'bin', 'pacr.js');
    const p = spawn(process.execPath, [bin, 'estimate', '--backfill', '--quiet'], {
      detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
    });
    p.on('error', () => {});
    p.unref();
  } catch { /* ignore */ }
}

// Replays saved snapshots of the last 8 days through observe(), with weighted tokens from the logs.
// observe() keeps the max-per-window rule: a value lower than the highest seen in its window (an idle
// session's stale number) is never a step, and an older window can't come back.
// Pure: snaps sorted by time, records = [{ts, tok}] sorted by time. Returns {f, w, found}.
function replay(snaps, records) {
  const cumAt = [];
  let run = 0;
  for (const r of records) { run += r.tok; cumAt.push(run); }
  const cum = (t) => { // tokens with ts <= t
    let lo = 0; let hi = records.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (records[m].ts <= t) lo = m + 1; else hi = m; }
    return lo ? cumAt[lo - 1] : 0;
  };
  const st = { f: undefined, w: undefined };
  const found = { f: { steps: 0, windows: new Map() }, w: { steps: 0, windows: new Map() } };
  for (const s of snaps) {
    for (const key of Object.keys(KEYS)) {
      const resetAt = s[KEYS[key].rkey];
      if (s[key] == null || resetAt == null) continue;
      const prev = st[key];
      const next = observe(prev, s[key], resetAt, cum(s.t), s.t);
      if (next === prev) continue;
      st[key] = next;
      if (prev && prev.win === next.win && next.n > prev.n) {
        found[key].steps++;
        const w = found[key].windows.get(next.win) || { resetAt: next.r, steps: 0, rates: [] };
        w.steps++;
        w.rates = next.rates.slice();
        found[key].windows.set(next.win, w);
      }
    }
  }
  const sum = (k) => ({
    steps: found[k].steps,
    windows: [...found[k].windows.values()],
    perPct: st[k] ? Math.round(avg(st[k].rates) || avg(st[k].hist) || 0) || null : null
  });
  return { f: st.f, w: st.w, found: { f: sum('f'), w: sum('w') }, cum };
}

function backfill(now = Date.now()) {
  const since = now - BACKFILL_MS;
  const snaps = snapshots.read({ since, until: now + 1 });
  const records = logs.scan({ since }).records.map((r) => ({ ts: r.ts, tok: logs.weighted(r) }));
  const res = replay(snaps, records);
  // Move the anchor of each current window into the rollup's frame (tokens since the window's fixed start).
  const roll = logs.updateRollup({ minIntervalMs: 0, now });
  for (const key of Object.keys(KEYS)) {
    const s = res[key];
    if (s && s.at != null && s.r > now) s.tok = windowTokens(roll, key, s.r, now) - (res.cum(now) - res.cum(s.at));
  }
  const all = load();
  for (const key of Object.keys(KEYS)) if (res[key]) all[key] = res[key];
  all.backfilled = now;
  delete all.backfillStarted;
  writeJSON(file('estimate.json'), all);
  return { since, snapshots: snaps.length, found: res.found };
}

// What to show: the estimate rounded like claude.ai, "~" when it differs from Claude Code's number.
function display(raw, est) {
  if (!est) return { pct: raw, text: null };
  return { pct: est.value, text: est.approx ? `~${est.shown}%` : null };
}

module.exports = { observe, estimate, forSnap, display, windowTokens, replay, backfill };
