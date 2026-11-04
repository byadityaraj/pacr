'use strict';
// Current usage state, shared by the status line, alerts and the VS Code extension.
const config = require('./config');
const logs = require('./logs');
const snapshots = require('./snapshots');
const { startOfDay, DAY } = require('./util');

const BURN_LOOKBACK_MS = 30 * 60000;
const BURN_MIN_SPAN_MS = 10 * 60000;

// Burn rate of the 5-hour window from recent snapshots in the same window.
function burnRate(snap, history, now = Date.now()) {
  if (!snap || snap.f == null || snap.fr == null) return null;
  const id = snapshots.winId(snap.fr);
  const pts = history
    .filter((s) => s.f != null && snapshots.winId(s.fr) === id && s.t >= now - BURN_LOOKBACK_MS && s.t < snap.t)
    .concat([snap]);
  if (pts.length < 2) return null;
  const first = pts[0];
  const span = snap.t - first.t;
  if (span < BURN_MIN_SPAN_MS) return null;
  const perMin = (snap.f - first.f) / (span / 60000);
  const minsToReset = Math.max(0, (snap.fr - now) / 60000);
  if (perMin <= 0.005) return { perHour: 0, minsToFull: null, minsToReset, willHit: false };
  const minsToFull = Math.max(0, (100 - snap.f) / perMin);
  return { perHour: perMin * 60, minsToFull, minsToReset, willHit: minsToFull < minsToReset };
}

// The one action most likely to save tokens right now.
function quickTip(snap) {
  if (!snap) return null;
  if (snap.c != null && snap.c >= 50) return `try /compact (ctx ${Math.round(snap.c)}%)`;
  const model = `${snap.m || ''} ${snap.mid || ''}`.toLowerCase();
  if (model.includes('opus')) return 'try /model sonnet for routine steps';
  return 'starting something new? /clear first';
}

// input: the status line JSON (optional). Without it, the last saved snapshot is used.
function getState({ input = null, now = Date.now(), minScanIntervalMs = 5000 } = {}) {
  const cfg = config.load();
  const cr = cfg.countCacheReads === true;
  let snap = null;
  let snapAgeMs = null;
  if (input) {
    snap = snapshots.fromInput(input, now);
  } else {
    snap = snapshots.latest();
    if (snap) snapAgeMs = now - snap.t;
  }
  // Limit windows that already reset are no longer valid.
  if (snap && snap.fr != null && snap.fr <= now) { snap = { ...snap, f: null, fr: null }; }
  if (snap && snap.wr != null && snap.wr <= now) { snap = { ...snap, w: null, wr: null }; }

  const roll = logs.updateRollup({ minIntervalMs: minScanIntervalMs, now });
  const weekStart = snap && snap.wr ? snap.wr - 7 * DAY : now - 7 * DAY;
  const tokens = {
    hour: logs.rollupSum(roll, now - 3600000, now, cr),
    today: logs.rollupSum(roll, startOfDay(now), now, cr),
    week: logs.rollupSum(roll, Math.max(weekStart, now - 7 * DAY), now, cr),
    weekIsLimitWindow: !!(snap && snap.wr),
    session: snap && snap.sid && roll.s[snap.sid] ? roll.s[snap.sid][cr ? 0 : 1] : null
  };
  // Cache reads kept out of the totals above (null when they're included).
  const cachedIn = (from) => logs.rollupSum(roll, from, now, true) - logs.rollupSum(roll, from, now, false);
  tokens.cached = cr ? null : {
    hour: cachedIn(now - 3600000),
    today: cachedIn(startOfDay(now)),
    week: cachedIn(Math.max(weekStart, now - 7 * DAY)),
    session: snap && snap.sid && roll.s[snap.sid] ? roll.s[snap.sid][0] - roll.s[snap.sid][1] : null
  };

  const history = snap ? snapshots.readRecent(now - BURN_LOOKBACK_MS - 60000) : [];
  const burn = burnRate(snap, history, now);

  const budget = {
    daily: cfg.budget && cfg.budget.daily ? { limit: cfg.budget.daily, used: tokens.today, pct: (tokens.today / cfg.budget.daily) * 100 } : null,
    weekly: cfg.budget && cfg.budget.weekly ? { limit: cfg.budget.weekly, used: tokens.week, pct: (tokens.week / cfg.budget.weekly) * 100 } : null
  };

  return { now, cfg, snap, snapAgeMs, tokens, burn, budget, tip: quickTip(snap) };
}

module.exports = { getState, burnRate, quickTip };
