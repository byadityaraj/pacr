'use strict';
const { file } = require('./paths');
const { readJSON, writeJSON } = require('./store');

const DEFAULTS = {
  // Status line colors: yellow at warn %, red at danger %.
  warnPct: 70,
  dangerPct: 90,
  // Token totals count fresh tokens only (input + output + cache writes). Cache reads count far
  // less toward limits, so they're shown separately as "+X cached". true = include them in the
  // totals (matches ccusage).
  countCacheReads: false,
  // Your own token budgets (null = off). Example: 3000000 for 3M/day.
  budget: { daily: null, weekly: null },
  // Desktop notifications.
  notify: {
    enabled: true,
    fiveHour: [90],          // notify when the 5h window crosses these %
    weekly: [80, 90],        // notify when the weekly window crosses these %
    burnRate: true,          // notify once per window when projected to hit the limit soon
    burnMinutes: 45,         // ...within this many minutes
    resetReady: true,        // notify when a window you maxed out resets
    budget: true,            // notify at 80% and 100% of your budget
    sessionCostUsd: 5,       // nudge when one session passes this estimated cost (null = off)
    weeklySummary: true      // one summary notification each Monday
  }
};

function merge(base, over) {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return over === undefined ? base : over;
  const out = { ...base };
  for (const k of Object.keys(over)) {
    out[k] = base && typeof base[k] === 'object' && !Array.isArray(base[k]) && base[k] !== null
      ? merge(base[k], over[k])
      : over[k];
  }
  return out;
}

function load() {
  return merge(DEFAULTS, readJSON(file('config.json'), {}));
}

function save(cfg) {
  writeJSON(file('config.json'), cfg);
}

// Set a dotted key, e.g. set('notify.fiveHour', [80, 95]).
function set(key, value) {
  const raw = readJSON(file('config.json'), {});
  const parts = key.split('.');
  let o = raw;
  for (let i = 0; i < parts.length - 1; i++) {
    if (typeof o[parts[i]] !== 'object' || o[parts[i]] === null) o[parts[i]] = {};
    o = o[parts[i]];
  }
  o[parts[parts.length - 1]] = value;
  save(raw);
  return load();
}

function get(key) {
  return key.split('.').reduce((o, k) => (o == null ? undefined : o[k]), load());
}

module.exports = { DEFAULTS, load, save, set, get };
