'use strict';
// Snapshots of the official limit percentages that Claude Code passes to the status line.
// Claude Code doesn't keep a history of these, so pacr logs one roughly every minute.
const { file } = require('./paths');
const { readJSON, writeJSON, appendJSONL, readJSONL, readJSONLTail, pruneJSONL } = require('./store');

const MIN_GAP_MS = 60000;
const HIT_PCT = 98;

function num(v) { return typeof v === 'number' && isFinite(v) ? v : null; }

function fromInput(input, now = Date.now()) {
  const rl = input.rate_limits || {};
  const fh = rl.five_hour || {};
  const sd = rl.seven_day || {};
  const cw = input.context_window || {};
  const ws = input.workspace || {};
  return {
    t: now,
    sid: input.session_id || null,
    m: (input.model && (input.model.display_name || input.model.id)) || null,
    mid: (input.model && input.model.id) || null,
    f: num(fh.used_percentage),
    fr: num(fh.resets_at) != null ? fh.resets_at * 1000 : null,
    w: num(sd.used_percentage),
    wr: num(sd.resets_at) != null ? sd.resets_at * 1000 : null,
    c: num(cw.used_percentage),
    usd: input.cost ? num(input.cost.total_cost_usd) : null,
    p: ws.project_dir || ws.current_dir || input.cwd || null
  };
}

// Save the snapshot: always as "latest", and into the history log at most once a minute
// (or sooner when a percentage moves by a full point).
function record(snap) {
  writeJSON(file('latest.json'), snap);
  const st = readJSON(file('snap-state.json'), {});
  const last = st.last;
  const moved = last && ((snap.f != null && last.f != null && Math.abs(snap.f - last.f) >= 1)
    || (snap.w != null && last.w != null && Math.abs(snap.w - last.w) >= 1));
  if (!last || snap.t - last.t >= MIN_GAP_MS || moved || snap.sid !== last.sid) {
    appendJSONL(file('snapshots.jsonl'), snap);
    writeJSON(file('snap-state.json'), { last: snap });
    pruneJSONL(file('snapshots.jsonl'), 't', 120 * 86400000);
  }
}

function latest() { return readJSON(file('latest.json'), null); }

function read({ since = 0, until = Infinity } = {}) {
  return readJSONL(file('snapshots.jsonl'), (o) => o.t >= since && o.t < until).sort((a, b) => a.t - b.t);
}

// Recent snapshots only (reads the end of the file) — used on the status line's hot path.
function readRecent(since) {
  return readJSONLTail(file('snapshots.jsonl'), 256 * 1024, (o) => o.t >= since).sort((a, b) => a.t - b.t);
}

const winId = (r) => (r == null ? null : Math.round(r / 300000));

// Positive increases of a limit % between snapshots, kept inside the same window.
// key 'f' (5-hour) or 'w' (weekly). Returns [{t, inc}].
function increments(snaps, key = 'f') {
  const rkey = key === 'f' ? 'fr' : 'wr';
  const maxByWin = new Map();
  const out = [];
  for (const s of snaps) {
    const v = s[key];
    const id = winId(s[rkey]);
    if (v == null || id == null) continue;
    const prev = maxByWin.get(id);
    if (prev == null) { maxByWin.set(id, v); continue; }
    if (v > prev) { out.push({ t: s.t, inc: v - prev }); maxByWin.set(id, v); }
  }
  return out;
}

// Windows where you reached the limit. key 'f' or 'w'.
function hits(snaps, key = 'f', pct = HIT_PCT) {
  const rkey = key === 'f' ? 'fr' : 'wr';
  const wins = new Map();
  for (const s of snaps) {
    const id = winId(s[rkey]);
    if (id == null || s[key] == null) continue;
    let w = wins.get(id);
    if (!w) { w = { resetAt: s[rkey], max: 0, hitAt: null }; wins.set(id, w); }
    w.max = Math.max(w.max, s[key]);
    if (s[key] >= pct && w.hitAt == null) w.hitAt = s.t;
  }
  return [...wins.values()].filter((w) => w.hitAt != null).sort((a, b) => a.hitAt - b.hitAt);
}

// Peak % per window.
function windows(snaps, key = 'w') {
  const rkey = key === 'f' ? 'fr' : 'wr';
  const wins = new Map();
  for (const s of snaps) {
    const id = winId(s[rkey]);
    if (id == null || s[key] == null) continue;
    const w = wins.get(id) || { resetAt: s[rkey], max: 0, first: s.t, last: s.t };
    w.max = Math.max(w.max, s[key]);
    w.last = s.t;
    wins.set(id, w);
  }
  return [...wins.values()].sort((a, b) => a.resetAt - b.resetAt);
}

module.exports = { fromInput, record, latest, read, readRecent, increments, hits, windows, winId, HIT_PCT };
