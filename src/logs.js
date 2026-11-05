'use strict';
// Reads Claude Code's local session logs (~/.claude/projects/**/*.jsonl).
// Read-only: never touches credentials, never makes network calls.
const fs = require('fs');
const path = require('path');
const { projectDirs, file } = require('./paths');
const { readJSON, writeJSON } = require('./store');

function walk(dir, sinceMs, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, sinceMs, out);
    else if (e.isFile() && e.name.endsWith('.jsonl')) {
      try {
        const st = fs.statSync(p);
        if (st.mtimeMs >= sinceMs) out.push({ path: p, size: st.size, mtime: st.mtimeMs });
      } catch { /* ignore */ }
    }
  }
  return out;
}

function listFiles(sinceMs = 0) {
  const out = [];
  for (const d of projectDirs()) walk(d, sinceMs, out);
  return out;
}

// Parse one log line into a usage record (or null).
function parseLine(line) {
  if (!line || line.indexOf('"usage"') === -1) return null;
  let o;
  try { o = JSON.parse(line); } catch { return null; }
  const msg = o && o.message;
  const u = msg && msg.usage;
  if (!u || o.type !== 'assistant') return null;
  if (msg.model === '<synthetic>' || o.isApiErrorMessage) return null;
  const ts = Date.parse(o.timestamp);
  if (!isFinite(ts)) return null;
  const tools = [];
  if (Array.isArray(msg.content)) {
    for (const b of msg.content) if (b && b.type === 'tool_use' && b.name) tools.push(b.name);
  }
  return {
    ts,
    key: msg.id && o.requestId ? `${msg.id}:${o.requestId}` : (msg.id || null),
    sid: o.sessionId || '?',
    cwd: o.cwd || '',
    branch: o.gitBranch || '',
    model: msg.model || '?',
    side: !!o.isSidechain,
    inp: u.input_tokens || 0,
    out: u.output_tokens || 0,
    cw: u.cache_creation_input_tokens || 0,
    cr: u.cache_read_input_tokens || 0,
    tools
  };
}

function total(r, countCacheReads = false) {
  return r.inp + r.out + r.cw + (countCacheReads ? r.cr : 0);
}

// Tokens weighted like API prices relative to input: cache writes 1.25×, output 5×, cache reads 0.1×.
// Limits seem to track cost, so this follows them better than fresh tokens when cache reads dominate.
function weighted(r) {
  return Math.round(r.inp + 1.25 * r.cw + 5 * r.out + 0.1 * r.cr);
}

// Full scan for reports. Returns records sorted by time plus MCP servers seen in tool calls.
function scan({ since = 0, until = Infinity } = {}) {
  const files = listFiles(since);
  // One API response can be logged as several lines (one per content block), and resumed
  // sessions copy earlier lines. Keep one record per response, with the largest usage seen.
  const seen = new Map();
  const records = [];
  const mcpUsed = new Set();
  for (const f of files) {
    let txt;
    try { txt = fs.readFileSync(f.path, 'utf8'); } catch { continue; }
    for (const line of txt.split('\n')) {
      const r = parseLine(line);
      if (!r) continue;
      for (const name of r.tools) {
        const m = name.match(/^mcp__(.+?)__/);
        if (m) mcpUsed.add(m[1]);
      }
      if (r.ts < since || r.ts >= until) continue;
      delete r.tools;
      if (r.key) {
        const prev = seen.get(r.key);
        if (prev) {
          if (total(r, true) > total(prev, true)) Object.assign(prev, { inp: r.inp, out: r.out, cw: r.cw, cr: r.cr });
          continue;
        }
        seen.set(r.key, r);
      }
      delete r.key;
      records.push(r);
    }
  }
  records.sort((a, b) => a.ts - b.ts);
  return { records, mcpUsed };
}

// ---------- fast incremental rollup for the status line and VS Code ----------
// Keeps 5-minute token buckets for the last 8 days and reads only new bytes of each log.
const BUCKET = 5 * 60000;
const KEEP_MS = 8 * 86400000;

function readNew(p, from, size) {
  const len = size - from;
  if (len <= 0) return { lines: [], next: from };
  const fd = fs.openSync(p, 'r');
  try {
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, from);
    const lastNL = buf.lastIndexOf(10);
    if (lastNL === -1) return { lines: [], next: from };
    return { lines: buf.slice(0, lastNL).toString('utf8').split('\n'), next: from + lastNL + 1 };
  } finally {
    fs.closeSync(fd);
  }
}

function updateRollup({ minIntervalMs = 5000, now = Date.now() } = {}) {
  const p = file('rollup.json');
  let r = readJSON(p, null);
  if (!r || r.v !== 1) r = { v: 1, files: {}, b: {}, s: {}, seen: {}, updated: 0 };
  if (now - r.updated < minIntervalMs) return r;

  const cutoff = now - KEEP_MS;
  const files = listFiles(cutoff);
  for (const f of files) {
    const st = r.files[f.path] || { off: 0 };
    if (f.size < st.off) st.off = 0; // file was rewritten
    if (f.size === st.off) { r.files[f.path] = st; continue; }
    let res;
    try { res = readNew(f.path, st.off, f.size); } catch { continue; }
    for (const line of res.lines) {
      const rec = parseLine(line);
      if (!rec || rec.ts < cutoff) continue;
      let k = Math.floor(rec.ts / BUCKET);
      let addAll = total(rec, true);
      let addNo = total(rec, false);
      let addWt = weighted(rec);
      if (rec.key) {
        const prev = r.seen[rec.key]; // [bucket, all, noCacheReads, weighted]
        if (prev) {
          // Same response logged again: only add the growth, if any.
          k = prev[0];
          const dAll = Math.max(0, addAll - prev[1]);
          const dNo = Math.max(0, addNo - prev[2]);
          // Entries from before the weighted column: take the current value as the baseline.
          const dWt = prev[3] == null ? 0 : Math.max(0, addWt - prev[3]);
          if (!dAll && !dNo && !dWt && prev[3] != null) continue;
          prev[1] += dAll; prev[2] += dNo; prev[3] = prev[3] == null ? addWt : prev[3] + dWt;
          addAll = dAll; addNo = dNo; addWt = dWt;
        } else {
          r.seen[rec.key] = [k, addAll, addNo, addWt];
        }
      }
      // Buckets: [all, noCacheReads, weighted]. Buckets written before 0.3.1 have no weighted value.
      const cur = r.b[k] || [0, 0, 0];
      cur[0] += addAll;
      cur[1] += addNo;
      cur[2] = (cur[2] || 0) + addWt;
      r.b[k] = cur;
      const s = r.s[rec.sid] || [0, 0, 0];
      s[0] += addAll;
      s[1] += addNo;
      s[2] = Math.max(s[2], rec.ts);
      r.s[rec.sid] = s;
    }
    st.off = res.next;
    r.files[f.path] = st;
  }

  // prune
  const minBucket = Math.floor(cutoff / BUCKET);
  for (const k of Object.keys(r.b)) if (+k < minBucket) delete r.b[k];
  for (const k of Object.keys(r.seen)) if (r.seen[k][0] < minBucket) delete r.seen[k];
  for (const k of Object.keys(r.s)) if (r.s[k][2] < cutoff) delete r.s[k];
  const live = new Set(files.map((f) => f.path));
  for (const k of Object.keys(r.files)) if (!live.has(k)) delete r.files[k];

  r.updated = now;
  writeJSON(p, r);
  return r;
}

// Sum tokens in the rollup between two timestamps. col: 0 all, 1 no cache reads, 2 weighted.
function rollupCol(r, from, to, col) {
  const a = Math.floor(from / BUCKET);
  const b = Math.floor(to / BUCKET);
  let sum = 0;
  for (const k of Object.keys(r.b)) {
    const n = +k;
    if (n >= a && n <= b) sum += r.b[k][col] || 0;
  }
  return sum;
}

function rollupSum(r, from, to, countCacheReads = false) {
  return rollupCol(r, from, to, countCacheReads ? 0 : 1);
}

function rollupWeighted(r, from, to) { return rollupCol(r, from, to, 2); }

module.exports = { listFiles, parseLine, total, weighted, scan, updateRollup, rollupSum, rollupWeighted, BUCKET };
