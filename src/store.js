'use strict';
// Small helpers for safe JSON / JSONL files in the data folder.
const fs = require('fs');
const path = require('path');

function readJSON(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

// Write via temp file + rename so concurrent status lines never see half a file.
function writeJSON(p, obj) {
  const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(obj));
    fs.renameSync(tmp, p);
  } catch {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
}

function appendJSONL(p, obj) {
  try { fs.appendFileSync(p, JSON.stringify(obj) + '\n'); } catch { /* ignore */ }
}

function readJSONL(p, filter) {
  let txt;
  try { txt = fs.readFileSync(p, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of txt.split('\n')) {
    if (!line) continue;
    try {
      const o = JSON.parse(line);
      if (!filter || filter(o)) out.push(o);
    } catch { /* skip bad line */ }
  }
  return out;
}

// Read only the last `bytes` of a JSONL file (fast path for recent entries).
function readJSONLTail(p, bytes, filter) {
  let fd;
  try {
    const size = fs.statSync(p).size;
    const from = Math.max(0, size - bytes);
    fd = fs.openSync(p, 'r');
    const buf = Buffer.alloc(size - from);
    fs.readSync(fd, buf, 0, buf.length, from);
    let txt = buf.toString('utf8');
    if (from > 0) txt = txt.slice(txt.indexOf('\n') + 1); // drop the partial first line
    const out = [];
    for (const line of txt.split('\n')) {
      if (!line) continue;
      try { const o = JSON.parse(line); if (!filter || filter(o)) out.push(o); } catch { /* skip */ }
    }
    return out;
  } catch {
    return [];
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

// Keep a JSONL file from growing forever: drop entries older than maxAgeMs.
function pruneJSONL(p, tsKey, maxAgeMs, maxBytes = 4 * 1024 * 1024) {
  let size = 0;
  try { size = fs.statSync(p).size; } catch { return; }
  if (size < maxBytes) return;
  const cutoff = Date.now() - maxAgeMs;
  const keep = readJSONL(p, (o) => (o[tsKey] || 0) >= cutoff);
  const tmp = `${p}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, keep.map((o) => JSON.stringify(o)).join('\n') + (keep.length ? '\n' : ''));
    fs.renameSync(tmp, p);
  } catch { /* ignore */ }
}

module.exports = { readJSON, writeJSON, appendJSONL, readJSONL, readJSONLTail, pruneJSONL };
