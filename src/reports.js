'use strict';
// Text reports for the CLI (ansi) and the VS Code panel (html). All return strings.
const config = require('./config');
const logs = require('./logs');
const snapshots = require('./snapshots');
const alertsMod = require('./alerts');
const { getState } = require('./state');
const A = require('./analyze');
const {
  c, t, bar, table, fmtTok, fmtDur, fmtUsd, fmtPct, levelColor, padEnd,
  DAY, HOUR, startOfDay, startOfHour, startOfWeek, dayKey, fmtDay, fmtHM, DOW, shortId, projName
} = require('./util');

const tot = (r, cr) => logs.total(r, cr);
const cr = () => config.load().countCacheReads === true;
// Dim "· +1.69B cached" after a total, when cache reads are kept out of it.
const cachedNote = (n, sep = ' · ') => (!cr() && n > 0 ? c('d', `${sep}+${fmtTok(n)} cached`) : '');
const cachedOf = (records) => records.reduce((x, r) => x + r.cr, 0);

// ---------------------------------------------------------------- today
function today({ date = null, now = Date.now() } = {}) {
  const dayStart = date != null ? date : startOfDay(now);
  const dayEnd = dayStart + DAY;
  const { records } = logs.scan({ since: dayStart, until: dayEnd });
  const snaps = snapshots.read({ since: dayStart - 6 * HOUR, until: dayEnd });
  const inc = snapshots.increments(snaps, 'f').filter((x) => x.t >= dayStart);
  const isToday = dayStart === startOfDay(now);

  const total = records.reduce((x, r) => x + tot(r, cr()), 0);
  const sids = new Set(records.map((r) => r.sid));
  const lines = [];
  lines.push(`${c('w', (isToday ? 'Today · ' : '') + fmtDay(dayStart))}   total ${c('w', fmtTok(total))} tokens${cachedNote(cachedOf(records))} · ${sids.size} session${sids.size === 1 ? '' : 's'}`);
  lines.push('');
  if (!records.length) {
    lines.push(c('d', 'No Claude Code usage logged for this day.'));
    return lines.join('\n');
  }
  const hours = new Map();
  for (const r of records) {
    const h = startOfHour(r.ts);
    const o = hours.get(h) || { tok: 0, sids: new Set(), bySid: new Map(), pct: 0 };
    const v = tot(r, cr());
    o.tok += v; o.sids.add(r.sid);
    o.bySid.set(r.sid, (o.bySid.get(r.sid) || 0) + v);
    hours.set(h, o);
  }
  for (const x of inc) {
    const h = startOfHour(x.t);
    const o = hours.get(h) || { tok: 0, sids: new Set(), bySid: new Map(), pct: 0 };
    o.pct += x.inc; hours.set(h, o);
  }
  const keys = [...hours.keys()].sort((a, b) => a - b);
  const first = keys[0];
  const last = isToday ? startOfHour(now) : keys[keys.length - 1];
  const max = Math.max(...[...hours.values()].map((o) => o.tok), 1);
  let peak = null;
  const rows = [];
  for (let h = first; h <= last; h += HOUR) {
    const o = hours.get(h);
    if (!o) { rows.push([fmtHM(h), bar(0, 24, 'g'), c('d', '—'), c('d', '—'), '']); continue; }
    if (!peak || o.tok > peak.o.tok) peak = { h, o };
    const pctTxt = o.pct ? `+${Math.round(o.pct)}%` : c('d', '—');
    rows.push([fmtHM(h), bar((o.tok / max) * 100, 24, o.tok === max ? 'y' : 'g'), fmtTok(o.tok), pctTxt, String(o.sids.size)]);
  }
  lines.push(table(['hour', 'usage', 'tokens', '5h window', 'sessions'], rows, ['l', 'l', 'r', 'r', 'r']));
  lines.push('');
  if (peak) {
    const topSid = [...peak.o.bySid.entries()].sort((a, b) => b[1] - a[1])[0][0];
    const s = A.sessionStats(records.filter((r) => r.sid === topSid), [], cr())[0];
    lines.push(c('y', `→ peak ${fmtHM(peak.h)}: ${fmtTok(peak.o.tok)} tokens` + (peak.o.pct ? `, ${Math.round(peak.o.pct)}% of a 5h window` : '')) +
      c('d', ` (mostly session ${shortId(topSid)}, ${A.shortModel(s.model)}, ${t(projName(s.cwd))})`));
  }
  if (isToday) {
    const st = getState({ now });
    if (st.snap && st.snap.f != null) {
      lines.push(c('d', `5h window: ${Math.round(st.snap.f)}% used · resets ${fmtHM(st.snap.fr)} (in ${fmtDur(st.snap.fr - now)})`));
    }
    if (st.budget.daily) lines.push(c('d', `daily budget: ${fmtTok(st.budget.daily.used)} of ${fmtTok(st.budget.daily.limit)} (${Math.round(st.budget.daily.pct)}%)`));
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------- week
function weekRange(now, last) {
  const latest = snapshots.latest();
  if (latest && latest.wr && latest.wr > now) {
    const end = latest.wr - (last ? 7 * DAY : 0);
    return { start: end - 7 * DAY, end, limitWindow: true };
  }
  const start = startOfWeek(now) - (last ? 7 * DAY : 0);
  return { start, end: start + 7 * DAY, limitWindow: false };
}

function week({ last = false, now = Date.now() } = {}) {
  const { start, end, limitWindow } = weekRange(now, last);
  const { records } = logs.scan({ since: start - 7 * DAY, until: end });
  const cur = records.filter((r) => r.ts >= start);
  const prev = records.filter((r) => r.ts < start);
  const snaps = snapshots.read({ since: start - DAY, until: end });
  const wInc = snapshots.increments(snaps, 'w').filter((x) => x.t >= start);
  const hits = snapshots.hits(snaps, 'f').filter((h) => h.hitAt >= start);
  const total = cur.reduce((x, r) => x + tot(r, cr()), 0);
  const lines = [];

  const latest = snapshots.latest();
  const wPct = !last && latest && latest.wr && latest.wr > now ? latest.w : null;
  const range = limitWindow ? `${fmtDay(start)} ${fmtHM(start)} – ${fmtDay(end)} ${fmtHM(end)}` : `${fmtDay(start)} – ${fmtDay(end - 1)}`;
  const head = `${c('w', (last ? 'Last week' : 'This week') + ` · ${range}`)}` +
    (limitWindow ? c('d', ' (your weekly limit window)') : '');
  lines.push(head);
  if (wPct != null) {
    const col = levelColor(wPct, config.load());
    lines.push(`weekly limit ${bar(wPct, 20, col)} ${c(col, Math.round(wPct) + '%')}  ${c('d', 'resets ' + fmtDay(latest.wr) + ' ' + fmtHM(latest.wr) + ' (in ' + fmtDur(latest.wr - now) + ')')}`);
  }
  lines.push('');

  const days = [];
  for (let d = startOfDay(start); d < end; d += DAY) days.push(d);
  const byDay = new Map(days.map((d) => [d, { tok: 0, pct: 0, hits: 0 }]));
  for (const r of cur) { const o = byDay.get(startOfDay(r.ts)); if (o) o.tok += tot(r, cr()); }
  for (const x of wInc) { const o = byDay.get(startOfDay(x.t)); if (o) o.pct += x.inc; }
  for (const h of hits) { const o = byDay.get(startOfDay(h.hitAt)); if (o) o.hits++; }
  const max = Math.max(1, ...[...byDay.values()].map((o) => o.tok));
  const rows = days.map((d) => {
    const o = byDay.get(d);
    const future = d > now;
    const isNow = !last && d === startOfDay(now);
    if (future) return [DOW[new Date(d).getDay()], c('d', '—'), '', '', '', ''];
    return [
      DOW[new Date(d).getDay()],
      fmtTok(o.tok),
      o.pct ? `+${Math.round(o.pct)}%` : c('d', '—'),
      o.hits ? c('r', String(o.hits)) : c('d', '0'),
      bar((o.tok / max) * 100, 16, isNow ? 'y' : 'g'),
      isNow ? c('d', 'today') : ''
    ];
  });
  lines.push(table(['day', 'tokens', 'weekly %', '5h limit hits', 'share', ''], rows, ['l', 'r', 'r', 'r', 'l', 'l']));
  lines.push('');

  const activeDays = [...byDay.entries()].filter(([d, o]) => d <= now && o.tok > 0).length;
  const busiest = [...byDay.entries()].sort((a, b) => b[1].tok - a[1].tok)[0];
  const projTok = new Map();
  for (const r of cur) projTok.set(projName(r.cwd), (projTok.get(projName(r.cwd)) || 0) + tot(r, cr()));
  const topProj = [...projTok.entries()].sort((a, b) => b[1] - a[1])[0];
  lines.push(`${c('d', 'total')} ${fmtTok(total)}${cachedNote(cachedOf(cur), '  · ')}  ${c('d', '· avg/active day')} ${fmtTok(activeDays ? total / activeDays : 0)}` +
    (busiest && busiest[1].tok ? `  ${c('d', '· busiest')} ${DOW[new Date(busiest[0]).getDay()]}` : '') +
    (topProj ? `  ${c('d', '· top project')} ${t(topProj[0])} (${Math.round((topProj[1] / Math.max(1, total)) * 100)}%)` : ''));

  // vs last week at the same point
  const elapsed = Math.min(end, now) - start;
  const prevSame = prev
    .filter((r) => r.ts >= start - 7 * DAY && r.ts < start - 7 * DAY + elapsed)
    .reduce((x, r) => x + tot(r, cr()), 0);
  if (prevSame > 0) {
    const ch = ((total - prevSame) / prevSame) * 100;
    lines.push(c('d', 'vs last week at this point: ') + `${fmtTok(prevSame)} → ${fmtTok(total)} ` + c(ch > 15 ? 'y' : 'g', `(${ch >= 0 ? '+' : ''}${Math.round(ch)}%)`));
  }

  // Projection of the weekly limit
  if (wPct != null && limitWindow) {
    const frac = (now - start) / (7 * DAY);
    if (frac > 0.1 && wPct > 0) {
      const projected = wPct / frac;
      const daysLeft = (end - now) / DAY;
      if (projected < 90) lines.push(c('g', `✓ projection: ~${Math.round(projected)}% by reset — you should stay under the weekly limit`));
      else if (projected < 100) lines.push(c('y', `⚠ projection: ~${Math.round(projected)}% by reset — close to the limit`));
      else lines.push(c('r', `⚠ projection: you'd hit the weekly limit ~${fmtDur(((100 - wPct) / (wPct / (now - start))))} from now`));
      if (total > 0 && daysLeft > 0.2) {
        const tokPerPct = total / wPct;
        const room = Math.max(0, (90 - wPct) * tokPerPct);
        lines.push(c('d', `  to keep a 10% buffer: about ${fmtTok(room / daysLeft)} tokens/day for the next ${daysLeft.toFixed(1)} days`));
      }
    }
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------- sessions
function sessions({ top = 10, days = 7, now = Date.now() } = {}) {
  const since = now - days * DAY;
  const { records } = logs.scan({ since });
  const snaps = snapshots.read({ since: since - DAY });
  const stats = A.sessionStats(records, snaps, cr());
  const periodTok = stats.reduce((x, s) => x + s.tokens, 0);
  const lines = [`${c('w', `Top sessions · last ${days} days`)}   ${c('d', `${stats.length} sessions · ${fmtTok(periodTok)} tokens`)}`, ''];
  if (!stats.length) { lines.push(c('d', 'No sessions found.')); return lines.join('\n'); }
  const rows = stats.slice(0, top).map((s, i) => {
    const flags = A.flagsFor(s, periodTok);
    const share = s.fiveShare != null ? Math.round(s.fiveShare) + '%' : c('d', '—');
    return [
      String(i + 1), shortId(s.sid), t(projName(s.cwd).slice(0, 14)), A.shortModel(s.model), String(s.msgs), fmtTok(s.tokens),
      s.usd != null ? fmtUsd(s.usd) : c('d', '—'), s.fiveShare != null ? c(levelColor(s.fiveShare, { warnPct: 20, dangerPct: 35 }), share) : share,
      flags.length ? c(flags.includes('heavy') ? 'r' : 'y', '▲ ' + flags.join(', ')) : c('g', 'ok')
    ];
  });
  lines.push(table(['#', 'session', 'project', 'model', 'msgs', 'tokens', 'cost*', 'of 5h**', 'flag'], rows, ['r', 'l', 'l', 'l', 'r', 'r', 'r', 'r', 'l']));
  const worst = stats.slice(0, top).find((s) => A.flagsFor(s, periodTok).length);
  if (worst) {
    lines.push('');
    lines.push(c('w', `why ${shortId(worst.sid)} is flagged`));
    if (worst.msgs >= A.LONG_SESSION_MSGS) {
      lines.push(`  ran ${worst.msgs} messages without a fresh start` + (worst.growth >= 2 ? ` → last 20 msgs cost ${c('r', worst.growth.toFixed(1) + '×')} the first 20` : ''));
    }
    if (worst.bigCtx) lines.push(`  ${worst.bigCtx} requests carried 150k+ tokens of context`);
    if (worst.rebuilds) lines.push(`  ${worst.rebuilds} cache rebuilds after idle pauses (${fmtTok(worst.rebuildTok)} tokens)`);
    if (periodTok && worst.tokens / periodTok >= 0.25) lines.push(`  ${Math.round((worst.tokens / periodTok) * 100)}% of all your tokens in this period`);
    lines.push(c('d', `  pacr session ${shortId(worst.sid)}   for the full timeline`));
  }
  lines.push('');
  lines.push(c('d', '* estimated by Claude Code at API list prices · ** share of a 5-hour window, from status line snapshots'));
  return lines.join('\n');
}

// ---------------------------------------------------------------- one session
function session({ id, now = Date.now() } = {}) {
  if (!id) return 'Usage: pacr session <id-prefix>';
  const { records } = logs.scan({ since: now - 60 * DAY });
  const sel = records.filter((r) => r.sid.startsWith(id));
  const sids = [...new Set(sel.map((r) => r.sid))];
  if (!sids.length) return `No session starting with "${t(id)}" in the last 60 days.`;
  if (sids.length > 1) return `"${t(id)}" matches ${sids.length} sessions: ${sids.map(shortId).join(', ')}. Use more characters.`;
  const snaps = snapshots.read({ since: sel[0].ts - DAY }).filter((s) => s.sid === sids[0]);
  const s = A.sessionStats(sel, snaps, cr())[0];
  const lines = [];
  lines.push(`${c('w', 'Session ' + s.sid)}`);
  lines.push(`${c('d', 'project')} ${t(s.cwd || '?')}   ${c('d', 'branch')} ${t(s.branch || '—')}   ${c('d', 'model')} ${A.shortModel(s.model)}`);
  lines.push(`${c('d', 'time')} ${fmtDay(s.first)} ${fmtHM(s.first)} → ${fmtHM(s.last)} (${fmtDur(s.last - s.first)})   ${c('d', 'messages')} ${s.msgs}${s.side ? c('d', ' + subagents') : ''}`);
  lines.push('');
  lines.push(table(['tokens', 'input', 'output', 'cache write', 'cache read', 'cost*', 'of 5h'], [[
    c('w', fmtTok(s.tokens)), fmtTok(s.inp), fmtTok(s.out), fmtTok(s.cw), fmtTok(s.cr), fmtUsd(s.usd), fmtPct(s.fiveShare)
  ]], ['r', 'r', 'r', 'r', 'r', 'r', 'r']));
  lines.push('');
  // Timeline in 30-minute buckets
  const B = 30 * 60000;
  const buckets = new Map();
  for (const r of sel) { const k = Math.floor(r.ts / B) * B; buckets.set(k, (buckets.get(k) || 0) + tot(r, cr())); }
  const ks = [...buckets.keys()].sort((a, b) => a - b);
  const max = Math.max(...buckets.values(), 1);
  lines.push(c('d', 'timeline (30 min)'));
  for (const k of ks.slice(-24)) lines.push(`  ${fmtHM(k)}  ${bar((buckets.get(k) / max) * 100, 30, 'g')} ${fmtTok(buckets.get(k))}`);
  if (ks.length > 24) lines.push(c('d', `  (showing last 24 of ${ks.length})`));
  if (s.growth) {
    lines.push('');
    lines.push(`late messages cost ${c(s.growth >= 2 ? 'r' : 'g', s.growth.toFixed(1) + '×')} early ones` + (s.growth >= 2 ? c('d', ' → /compact or /clear sooner next time') : ''));
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------- branches
function branches({ days = 30, now = Date.now() } = {}) {
  const { records } = logs.scan({ since: now - days * DAY });
  const map = new Map();
  for (const r of records) {
    const b = r.branch && r.branch !== 'HEAD' ? r.branch : '(no branch)';
    const k = `${projName(r.cwd)}\u0000${b}`;
    const o = map.get(k) || { proj: projName(r.cwd), branch: b, tok: 0, sids: new Set(), days: new Set(), first: r.ts, last: r.ts, msgs: 0 };
    o.tok += tot(r, cr()); o.sids.add(r.sid); o.days.add(dayKey(r.ts)); o.last = r.ts; if (!r.side) o.msgs++;
    map.set(k, o);
  }
  const list = [...map.values()].sort((a, b) => b.tok - a.tok);
  const lines = [`${c('w', `Tokens per branch · last ${days} days`)}`, ''];
  if (!list.length) { lines.push(c('d', 'No usage found.')); return lines.join('\n'); }
  const max = list[0].tok;
  lines.push(table(['project', 'branch', 'tokens', '', 'sessions', 'days', 'span'],
    list.slice(0, 15).map((o) => [t(o.proj.slice(0, 16)), t(o.branch.slice(0, 28)), fmtTok(o.tok), bar((o.tok / max) * 100, 12, 'g'),
      String(o.sids.size), String(o.days.size), c('d', `${fmtDay(o.first).slice(4)} → ${fmtDay(o.last).slice(4)}`)]),
    ['l', 'l', 'r', 'l', 'r', 'r', 'l']));
  if (list.length > 15) lines.push(c('d', `… ${list.length - 15} more`));
  lines.push('');
  lines.push(c('d', 'Branch comes from the git branch Claude Code logged for each message.'));
  return lines.join('\n');
}

// ---------------------------------------------------------------- heatmap
function heatmap({ weeks = 4, now = Date.now() } = {}) {
  const since = startOfDay(now) - (weeks * 7 - 1) * DAY;
  const { records } = logs.scan({ since });
  const grid = Array.from({ length: 7 }, () => new Array(24).fill(0));
  for (const r of records) {
    const d = new Date(r.ts);
    grid[(d.getDay() + 6) % 7][d.getHours()] += tot(r, cr());
  }
  const max = Math.max(1, ...grid.flat());
  const shades = [' ', '░', '▒', '▓', '█'];
  const lines = [`${c('w', `When you use the most tokens · last ${weeks} weeks`)}`, ''];
  lines.push('     ' + c('d', hourHeader()));
  const names = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  for (let d = 0; d < 7; d++) {
    const cells = grid[d].map((v) => {
      if (!v) return c('d', '· ');
      const lvl = Math.max(1, Math.min(4, Math.ceil((v / max) * 4)));
      return c(lvl >= 4 ? 'r' : lvl >= 3 ? 'y' : 'g', shades[lvl] + shades[lvl]);
    }).join('');
    lines.push(`${names[d]}  ${cells}`);
  }
  const hourTot = new Array(24).fill(0);
  const dayTot = new Array(7).fill(0);
  for (let d = 0; d < 7; d++) for (let h = 0; h < 24; h++) { hourTot[h] += grid[d][h]; dayTot[d] += grid[d][h]; }
  const bh = hourTot.indexOf(Math.max(...hourTot));
  const bd = dayTot.indexOf(Math.max(...dayTot));
  lines.push('');
  lines.push(`${c('d', 'busiest hour')} ${String(bh).padStart(2, '0')}:00  ${c('d', '· busiest day')} ${names[bd]}  ${c('d', '· legend')} ${c('g', '░')} low ${c('y', '▓')} high ${c('r', '█')} peak`);
  return lines.join('\n');
}

function hourHeader() {
  let s = '';
  for (let h = 0; h < 24; h += 3) s += String(h).padStart(2, '0').padEnd(6, ' ');
  return s;
}

// ---------------------------------------------------------------- tips
function tips({ days = 7, now = Date.now() } = {}) {
  const since = now - days * DAY;
  const { records, mcpUsed } = logs.scan({ since });
  const snaps = snapshots.read({ since });
  const list = A.tips({ records, snaps, mcpUsed, countCacheReads: cr() });
  const lines = [`${c('w', `Ways to save tokens · based on the last ${days} days`)}`, ''];
  if (!records.length) { lines.push(c('d', 'No usage found yet.')); return lines.join('\n'); }
  if (!list.length) { lines.push(c('g', '✓ Nothing stands out. Your sessions look efficient.')); return lines.join('\n'); }
  list.slice(0, 8).forEach((x, i) => {
    const save = x.saving ? `~${fmtTok(x.saving)} tokens` : (x.label || '');
    lines.push(`${c('y', String(i + 1))}  ${padEnd(t(x.title), 64)} ${c('g', save)}`);
    lines.push(`   ${c('d', t(x.detail))}`);
    lines.push(`   ${c('c', '→ ' + t(x.action))}`);
  });
  lines.push('');
  lines.push(c('d', 'Savings are rough estimates for the same period.'));
  return lines.join('\n');
}

// ---------------------------------------------------------------- plan fit
function plan({ days = 28, now = Date.now() } = {}) {
  const since = now - days * DAY;
  const { records } = logs.scan({ since });
  const snaps = snapshots.read({ since });
  const p = A.planFit({ records, snaps, days, countCacheReads: cr() });
  const lines = [`${c('w', `Plan fit · last ${days} days`)}`, ''];
  lines.push(`${padEnd(c('d', 'tokens'), 22)} ${fmtTok(p.tot)} over ${p.activeDays} active day${p.activeDays === 1 ? '' : 's'}` + (p.activeDays ? c('d', ` (avg ${fmtTok(p.tot / p.activeDays)}/day)`) : ''));
  lines.push(`${padEnd(c('d', '5h limit hits'), 22)} ${p.hits.length ? c('r', String(p.hits.length)) : c('g', '0')}` + (p.hits.length ? c('d', ` · ~${fmtDur(p.blockedMs)} spent waiting for resets`) : ''));
  lines.push(`${padEnd(c('d', 'weekly peak'), 22)} ${c(levelColor(p.weekPeak, config.load()), Math.round(p.weekPeak) + '%')}` + (p.weekHits ? c('r', ` · reached the weekly limit ${p.weekHits}×`) : ''));
  if (p.hits.length) {
    const max = Math.max(...p.byHour, 1);
    let s = '';
    for (let h = 0; h < 24; h++) s += p.byHour[h] ? c(p.byHour[h] === max ? 'r' : 'y', '▇') : c('d', '·');
    lines.push(`${padEnd(c('d', 'when you hit it'), 22)} ${s}  ${c('d', '00 → 23h')}`);
  }
  if (p.span < 7) lines.push(c('d', `(limit data covers only ${p.span.toFixed(1)} days so far; this gets more accurate over time)`));
  lines.push('');
  const col = /bound/.test(p.verdict) ? 'y' : p.verdict === 'no limit data yet' ? 'd' : 'g';
  lines.push(`${c('d', 'verdict')} ${c(col, p.verdict)}`);
  lines.push(t(p.advice));
  return lines.join('\n');
}

// ---------------------------------------------------------------- weekly summary
function summaryData({ last = true, now = Date.now() } = {}) {
  const start = startOfWeek(now) - (last ? 7 * DAY : 0);
  const end = start + 7 * DAY;
  const { records } = logs.scan({ since: start - 7 * DAY, until: end });
  const cur = records.filter((r) => r.ts >= start);
  const prev = records.filter((r) => r.ts < start);
  const snaps = snapshots.read({ since: start - 7 * DAY, until: end });
  const total = cur.reduce((x, r) => x + tot(r, cr()), 0);
  const prevTotal = prev.reduce((x, r) => x + tot(r, cr()), 0);
  const projTok = new Map();
  for (const r of cur) projTok.set(projName(r.cwd), (projTok.get(projName(r.cwd)) || 0) + tot(r, cr()));
  const topProj = [...projTok.entries()].sort((a, b) => b[1] - a[1])[0] || null;
  const hits = snapshots.hits(snaps.filter((s) => s.t >= start), 'f').length;
  const curSnaps = snaps.filter((s) => s.t >= start);
  const weekPeak = curSnaps.reduce((x, s) => Math.max(x, s.w || 0), 0);
  const tipList = A.tips({ records: cur, snaps: curSnaps, mcpUsed: new Set(['*']), countCacheReads: cr() })
    .filter((x) => !/MCP server/.test(x.title));
  return { start, end, total, cached: cachedOf(cur), prevTotal, topProj, hits, weekPeak, sessions: new Set(cur.map((r) => r.sid)).size, tip: tipList[0] || null };
}

function summary({ last = true, now = Date.now() } = {}) {
  const s = summaryData({ last, now });
  const lines = [`${c('w', `Weekly summary · ${fmtDay(s.start)} – ${fmtDay(s.end - 1)}`)}`, ''];
  if (!s.total) { lines.push(c('d', 'No usage that week.')); return lines.join('\n'); }
  const ch = s.prevTotal ? Math.round(((s.total - s.prevTotal) / s.prevTotal) * 100) : null;
  lines.push(`${padEnd(c('d', 'tokens'), 18)} ${c('w', fmtTok(s.total))}${cachedNote(s.cached)}` + (ch != null ? ` ${c(ch > 15 ? 'y' : 'g', `(${ch >= 0 ? '+' : ''}${ch}% vs week before)`)}` : ''));
  lines.push(`${padEnd(c('d', 'sessions'), 18)} ${s.sessions}`);
  if (s.topProj) lines.push(`${padEnd(c('d', 'top project'), 18)} ${t(s.topProj[0])} (${Math.round((s.topProj[1] / s.total) * 100)}%)`);
  lines.push(`${padEnd(c('d', '5h limit hits'), 18)} ${s.hits}`);
  if (s.weekPeak) lines.push(`${padEnd(c('d', 'weekly peak'), 18)} ${Math.round(s.weekPeak)}%`);
  if (s.tip) { lines.push(''); lines.push(`${c('y', 'one habit to change:')} ${t(s.tip.action)}`); lines.push(c('d', '  ' + t(s.tip.title))); }
  return lines.join('\n');
}

function summaryNotify() {
  const s = summaryData({ last: true });
  if (!s.total) return false;
  const ch = s.prevTotal ? Math.round(((s.total - s.prevTotal) / s.prevTotal) * 100) : null;
  const msg = `${fmtTok(s.total)} tokens` + (ch != null ? ` (${ch >= 0 ? '+' : ''}${ch}%)` : '') +
    (s.topProj ? `, top: ${s.topProj[0]}` : '') + `, ${s.hits} limit hit${s.hits === 1 ? '' : 's'}.` +
    (s.tip ? ` Tip: ${s.tip.action}` : '');
  alertsMod.push(config.load(), `summary:${dayKey(s.start)}`, 'info', 'Last week in Claude Code', msg);
  return true;
}

// ---------------------------------------------------------------- alerts view
function alertsView() {
  const cfg = config.load();
  const n = cfg.notify;
  const on = (v) => (v ? c('g', 'on') : c('d', 'off'));
  const lines = [c('w', 'Alerts'), ''];
  lines.push(table(['trigger', 'action', 'status'], [
    [`5h ≥ ${cfg.warnPct}%`, 'status line turns yellow', c('g', 'on')],
    [`5h ≥ ${cfg.dangerPct}%`, 'status line red + smart tip', c('g', 'on')],
    [`5h ≥ ${[].concat(n.fiveHour).join('/')}%`, 'desktop + VS Code alert', on(n.enabled && [].concat(n.fiveHour).length)],
    [`week ≥ ${[].concat(n.weekly).join('/')}%`, 'desktop + VS Code alert', on(n.enabled && [].concat(n.weekly).length)],
    ['burn rate', `"limit in < ${n.burnMinutes}m" warning`, on(n.enabled && n.burnRate)],
    ['maxed window resets', '"you\'re good to go"', on(n.enabled && n.resetReady)],
    ['your budget 80/100%', `daily ${cfg.budget.daily ? fmtTok(cfg.budget.daily) : 'off'} · weekly ${cfg.budget.weekly ? fmtTok(cfg.budget.weekly) : 'off'}`, on(n.enabled && n.budget && (cfg.budget.daily || cfg.budget.weekly))],
    [`session > $${n.sessionCostUsd || '—'}`, 'nudge to /clear or /compact', on(n.enabled && n.sessionCostUsd)],
    ['Monday', 'weekly summary', on(n.enabled && n.weeklySummary)]
  ]));
  const rec = alertsMod.recent(8);
  lines.push('');
  lines.push(c('d', 'recent'));
  if (!rec.length) lines.push(c('d', '  none yet'));
  for (const a of rec) {
    const col = a.level === 'danger' ? 'r' : a.level === 'warn' ? 'y' : 'g';
    const when = startOfDay(a.t) === startOfDay(Date.now()) ? fmtHM(a.t) : fmtDay(a.t).slice(0, 3) + ' ' + fmtHM(a.t);
    lines.push(`  ${padEnd(c('d', when), 10)} ${c(col, (a.level === 'info' ? '✓ ' : '⚠ ') + t(a.title))} ${c('d', '· ' + t(a.msg))}`);
  }
  lines.push('');
  lines.push(c('d', 'change: pacr config notify.fiveHour 80,95 · pacr budget daily 3M · pacr alerts test'));
  return lines.join('\n');
}

// ---------------------------------------------------------------- overview (default command)
function overview({ now = Date.now() } = {}) {
  const st = getState({ now });
  const sl = require('./statusline');
  const lines = [sl.tokenLine(st)];
  const k = st.tokens.cached;
  if (k && k.week > 0) lines.push(c('d', `cached (not counted above): hour ${fmtTok(k.hour)} · today ${fmtTok(k.today)} · week ${fmtTok(k.week)}`));
  const lim = sl.limitsLine(st);
  if (lim) lines.push(lim);
  const w = sl.warningLine(st);
  if (w) lines.push(w);
  if (st.snapAgeMs != null && st.snap && (st.snap.f != null || st.snap.w != null)) lines.push(c('d', `limits as of ${fmtDur(st.snapAgeMs)} ago (from the status line)`));
  if (!st.snap) lines.push(c('d', 'No limit data yet: run `pacr install` to add the status line.'));
  lines.push('');
  lines.push(c('d', 'more: pacr today | week | sessions | branches | heatmap | tips | plan | alerts | help'));
  return lines.join('\n');
}

module.exports = { today, week, sessions, session, branches, heatmap, tips, plan, summary, summaryNotify, alertsView, overview };
