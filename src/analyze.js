'use strict';
// Shared analysis over usage records: per-session stats, tips, plan fit.
const fs = require('fs');
const path = require('path');
const { HOME } = require('./paths');

// ~/… instead of the full home path: shorter, and safe to paste into an issue.
const tildify = (p) => (p === HOME || p.startsWith(HOME + path.sep) ? '~' + p.slice(HOME.length) : p);
const { total } = require('./logs');
const snapshots = require('./snapshots');
const { fmtTok } = require('./util');

const LONG_SESSION_MSGS = 60;
const BIG_CONTEXT = 150000;
const IDLE_MS = 5 * 60000;

function sessionStats(records, snaps, countCacheReads = false) {
  const map = new Map();
  for (const r of records) {
    let s = map.get(r.sid);
    if (!s) {
      s = { sid: r.sid, cwd: r.cwd, branches: new Map(), models: new Map(), first: r.ts, last: r.ts,
        msgs: 0, tokens: 0, inp: 0, out: 0, cw: 0, cr: 0, main: [], side: 0, bigCtx: 0, rebuilds: 0, rebuildTok: 0 };
      map.set(r.sid, s);
    }
    const tok = total(r, countCacheReads);
    s.tokens += tok; s.inp += r.inp; s.out += r.out; s.cw += r.cw; s.cr += r.cr;
    s.last = Math.max(s.last, r.ts);
    s.models.set(r.model, (s.models.get(r.model) || 0) + tok);
    if (r.branch) s.branches.set(r.branch, (s.branches.get(r.branch) || 0) + tok);
    if (r.side) { s.side += tok; continue; }
    const ctx = r.inp + r.cw + r.cr;
    if (ctx >= BIG_CONTEXT) s.bigCtx++;
    const prev = s.main[s.main.length - 1];
    if (prev && r.ts - prev.ts > IDLE_MS && r.ts - prev.ts < 3 * 3600000 && r.cw >= 10000 && r.cr < r.cw) {
      s.rebuilds++; s.rebuildTok += r.cw;
    }
    s.main.push({ ts: r.ts, tok, ctx });
    s.msgs++;
  }
  // Cost and limit share from status line snapshots (when available).
  const usd = new Map();
  for (const sn of snaps) if (sn.sid && sn.usd != null) usd.set(sn.sid, Math.max(usd.get(sn.sid) || 0, sn.usd));
  const share = new Map();
  const bySid = new Map();
  for (const sn of snaps) { if (sn.sid) { const a = bySid.get(sn.sid) || []; a.push(sn); bySid.set(sn.sid, a); } }
  // Attribute each 5h increase to the session whose snapshot recorded it.
  const all = snaps.slice().sort((a, b) => a.t - b.t);
  const maxByWin = new Map();
  for (const sn of all) {
    const id = snapshots.winId(sn.fr);
    if (sn.f == null || id == null) continue;
    const prev = maxByWin.get(id);
    if (prev != null && sn.f > prev && sn.sid) share.set(sn.sid, (share.get(sn.sid) || 0) + (sn.f - prev));
    if (prev == null || sn.f > prev) maxByWin.set(id, sn.f);
  }
  for (const s of map.values()) {
    s.usd = usd.has(s.sid) ? usd.get(s.sid) : null;
    s.fiveShare = share.has(s.sid) ? share.get(s.sid) : null;
    s.model = [...s.models.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || '?';
    s.branch = [...s.branches.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || '';
    // Growth: average context per message (incl. cache reads, whatever countCacheReads says), last 20 vs first 20.
    if (s.main.length >= 40) {
      const avg = (a) => a.reduce((x, m) => x + m.ctx, 0) / a.length;
      s.growth = avg(s.main.slice(-20)) / Math.max(1, avg(s.main.slice(0, 20)));
    } else s.growth = null;
    s.lateTok = s.main.slice(LONG_SESSION_MSGS).reduce((x, m) => x + m.tok, 0);
  }
  return [...map.values()].sort((a, b) => b.tokens - a.tokens);
}

function shortModel(m) {
  const s = String(m || '?').toLowerCase();
  if (s.includes('opus')) return 'Opus';
  if (s.includes('sonnet')) return 'Sonnet';
  if (s.includes('haiku')) return 'Haiku';
  if (s.includes('fable')) return 'Fable';
  if (s.includes('mythos')) return 'Mythos';
  return String(m || '?').replace(/^claude-/, '').slice(0, 12);
}

function flagsFor(s, periodTokens) {
  const f = [];
  if (periodTokens && s.tokens / periodTokens >= 0.25) f.push('heavy');
  if (s.msgs >= LONG_SESSION_MSGS && s.growth && s.growth >= 2) f.push('long context');
  else if (s.bigCtx >= 5) f.push('big context');
  if (s.rebuilds >= 3) f.push('cache rebuilds');
  return f;
}

// ---------- CLAUDE.md and MCP config (read-only) ----------
function fileTokens(p) {
  try { return Math.round(fs.statSync(p).size / 4); } catch { return 0; }
}

function memoryFiles(projectPaths) {
  const out = [];
  const add = (p, scope) => { const tok = fileTokens(p); if (tok) out.push({ path: p, tokens: tok, scope }); };
  add(path.join(HOME, '.claude', 'CLAUDE.md'), 'global');
  for (const pp of projectPaths) {
    add(path.join(pp, 'CLAUDE.md'), pp);
    add(path.join(pp, '.claude', 'CLAUDE.md'), pp);
    add(path.join(pp, 'CLAUDE.local.md'), pp);
  }
  return out;
}

function configuredMcp(projectPaths) {
  const out = new Map(); // name -> scope
  let cj = null;
  try { cj = JSON.parse(fs.readFileSync(path.join(HOME, '.claude.json'), 'utf8')); } catch { /* none */ }
  if (cj && cj.mcpServers) for (const k of Object.keys(cj.mcpServers)) out.set(k, 'global');
  for (const pp of projectPaths) {
    const proj = cj && cj.projects && cj.projects[pp];
    if (proj && proj.mcpServers) for (const k of Object.keys(proj.mcpServers)) if (!out.has(k)) out.set(k, pp);
    try {
      const m = JSON.parse(fs.readFileSync(path.join(pp, '.mcp.json'), 'utf8'));
      if (m && m.mcpServers) for (const k of Object.keys(m.mcpServers)) if (!out.has(k)) out.set(k, pp);
    } catch { /* none */ }
  }
  return out;
}

// ---------- tips ----------
function tips({ records, snaps, mcpUsed, countCacheReads = false }) {
  const out = [];
  const tot = records.reduce((x, r) => x + total(r, countCacheReads), 0);
  if (!tot) return out;
  const sessions = sessionStats(records, snaps, countCacheReads);

  // 1. Long sessions without /clear
  const longs = sessions.filter((s) => s.msgs >= LONG_SESSION_MSGS);
  const late = longs.reduce((x, s) => x + s.lateTok, 0);
  if (longs.length && late / tot >= 0.1) {
    const worst = longs.filter((s) => s.growth).sort((a, b) => b.growth - a.growth)[0];
    out.push({
      saving: Math.round(late * 0.4),
      title: `${longs.length} session${longs.length > 1 ? 's' : ''} went ${LONG_SESSION_MSGS}+ messages without a fresh start`,
      detail: `${Math.round((late / tot) * 100)}% of your tokens came after message ${LONG_SESSION_MSGS}` +
        (worst ? `; in ${worst.sid.slice(0, 6)} the last messages cost ${worst.growth.toFixed(1)}× the first` : ''),
      action: '/clear when you switch tasks, /compact when you continue the same one'
    });
  }

  // 2. Opus share
  const opus = records.filter((r) => /opus/i.test(r.model)).reduce((x, r) => x + total(r, countCacheReads), 0);
  if (opus / tot >= 0.5) {
    out.push({
      saving: Math.round(opus * 0.3),
      title: `Opus used for ${Math.round((opus / tot) * 100)}% of tokens`,
      detail: 'Opus uses your limits faster than Sonnet',
      action: '/model sonnet for routine edits, tests and reads; Opus for hard problems'
    });
  }

  // 3. Big context requests
  const big = sessions.reduce((x, s) => x + s.bigCtx, 0);
  if (big >= 10) {
    const excess = records.filter((r) => !r.side && r.inp + r.cw + r.cr >= BIG_CONTEXT)
      .reduce((x, r) => x + (r.inp + r.cw + r.cr - 100000), 0);
    out.push({
      saving: Math.round(excess * 0.5),
      title: `${big} requests carried 150k+ tokens of context`,
      detail: 'every message resends the whole conversation',
      action: '/compact earlier (around 50% context), or tell Claude which files to read'
    });
  }

  // 4. Cache rebuilds after idle gaps
  const rebuilds = sessions.reduce((x, s) => x + s.rebuilds, 0);
  const rebuildTok = sessions.reduce((x, s) => x + s.rebuildTok, 0);
  if (rebuilds >= 5) {
    out.push({
      saving: rebuildTok,
      title: `${rebuilds} cache rebuilds after 5+ minute pauses`,
      detail: `~${fmtTok(rebuildTok)} tokens re-cached; the prompt cache expires after ~5 minutes idle`,
      action: 'batch your questions; after a long break on a big session, /compact first'
    });
  }

  // 5. CLAUDE.md size
  const projTok = new Map();
  const projReq = new Map();
  for (const r of records) {
    if (!r.cwd) continue;
    projTok.set(r.cwd, (projTok.get(r.cwd) || 0) + total(r, countCacheReads));
    if (!r.side) projReq.set(r.cwd, (projReq.get(r.cwd) || 0) + 1);
  }
  const topProjects = [...projTok.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map((e) => e[0]);
  const mem = memoryFiles(topProjects);
  const memTotal = mem.reduce((x, m) => x + m.tokens, 0);
  if (memTotal > 3000) {
    const reqs = records.filter((r) => !r.side).length;
    const biggest = mem.sort((a, b) => b.tokens - a.tokens)[0];
    out.push({
      saving: Math.round((memTotal - 2000) * reqs),
      title: `Memory files (CLAUDE.md) total ~${(memTotal / 1000).toFixed(1)}k tokens`,
      detail: `loaded into every request; largest: ${tildify(biggest.path)} (~${(biggest.tokens / 1000).toFixed(1)}k)`,
      action: 'trim them to the essentials (aim for under 2k tokens)'
    });
  }

  // 6. Unused MCP servers
  const conf = configuredMcp(topProjects);
  const unused = [...conf.keys()].filter((k) => !mcpUsed.has(k));
  if (unused.length) {
    out.push({
      saving: null,
      label: 'smaller requests',
      title: `${unused.length} MCP server${unused.length > 1 ? 's' : ''} configured but never used: ${unused.slice(0, 4).join(', ')}`,
      detail: 'their tool definitions are sent with requests',
      action: 'disable them in projects where you don\'t need them (/mcp)'
    });
  }

  // 7. Subagents
  const side = records.filter((r) => r.side).reduce((x, r) => x + total(r, countCacheReads), 0);
  if (side / tot >= 0.35) {
    out.push({
      saving: Math.round(side * 0.2),
      title: `Subagents used ${Math.round((side / tot) * 100)}% of tokens`,
      detail: 'each subagent starts with its own context',
      action: 'use them for wide searches; for one known file, ask directly'
    });
  }

  // 8. Limit hits concentrated in certain hours
  const h = snapshots.hits(snaps, 'f');
  if (h.length >= 2) {
    const byHour = new Array(24).fill(0);
    for (const x of h) byHour[new Date(x.hitAt).getHours()]++;
    let best = 0; let bestStart = 0;
    for (let i = 0; i < 24; i++) { const v = byHour[i] + byHour[(i + 1) % 24] + byHour[(i + 2) % 24]; if (v > best) { best = v; bestStart = i; } }
    out.push({
      saving: null,
      label: 'fewer lockouts',
      title: `You hit the 5-hour limit ${h.length} times` + (best >= 2 ? `, ${best} of them between ${String(bestStart).padStart(2, '0')}:00–${String((bestStart + 3) % 24).padStart(2, '0')}:00` : ''),
      detail: 'the 5-hour window starts with your first message',
      action: 'switch to Sonnet when the bar turns yellow, or spread heavy work across windows'
    });
  }

  out.sort((a, b) => (b.saving || 0) - (a.saving || 0));
  return out;
}

// ---------- plan fit ----------
function planFit({ records, snaps, days, countCacheReads = false }) {
  const span = snaps.length ? (snaps[snaps.length - 1].t - snaps[0].t) / 86400000 : 0;
  const hits = snapshots.hits(snaps, 'f');
  const weeks = snapshots.windows(snaps, 'w');
  const blockedMs = hits.reduce((x, h) => x + Math.max(0, h.resetAt - h.hitAt), 0);
  const byHour = new Array(24).fill(0);
  for (const h of hits) byHour[new Date(h.hitAt).getHours()]++;
  const tot = records.reduce((x, r) => x + total(r, countCacheReads), 0);
  const activeDays = new Set(records.map((r) => new Date(r.ts).toDateString())).size;
  const weekPeak = weeks.reduce((x, w) => Math.max(x, w.max), 0);
  const weekHits = weeks.filter((w) => w.max >= snapshots.HIT_PCT).length;
  const perMonth = span > 0 ? (hits.length / span) * 30 : 0;

  let verdict; let advice;
  if (!snaps.length) {
    verdict = 'no limit data yet';
    advice = 'Limit percentages come from the status line. Run `pacr install`, use Claude Code for a few days, then check again.';
  } else if (weekHits >= 1 || weekPeak >= 95) {
    verdict = 'weekly-limit bound';
    advice = 'You reached (or nearly reached) the weekly limit. Saving tokens matters most here: Sonnet for routine work, /clear between tasks. If this happens most weeks, a higher plan may fit.';
  } else if (perMonth >= 8) {
    verdict = 'often 5-hour-limit bound';
    advice = 'You hit the 5-hour limit often. Spread heavy work across windows, switch to Sonnet when the bar turns yellow, or consider a higher plan if lockouts cost you real time.';
  } else if (hits.length === 0 && weekPeak < 40 && span >= 7) {
    verdict = 'plenty of headroom';
    advice = 'You never hit the 5-hour limit and stay well under the weekly limit. A lower plan might cover you; check its limits before switching.';
  } else {
    verdict = 'good fit';
    advice = 'Occasional limit hits at most. Your current plan looks right for how you work.';
  }
  return { days, span, hits, blockedMs, byHour, weeks, weekPeak, weekHits, tot, activeDays, perMonth, verdict, advice };
}

module.exports = { sessionStats, flagsFor, shortModel, tips, planFit, memoryFiles, configuredMcp, LONG_SESSION_MSGS };
