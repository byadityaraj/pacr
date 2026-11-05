#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const util = require('../src/util');
const pkg = require('../package.json');

// `pacr … | head` closes the pipe early: stop quietly instead of printing an EPIPE stack trace.
process.stdout.on('error', (e) => { if (e && e.code === 'EPIPE') process.exit(0); throw e; });

const argv = process.argv.slice(2);
const cmd = argv[0] && !argv[0].startsWith('-') ? argv[0] : null;
const rest = cmd ? argv.slice(1) : argv;

function flag(name) { return rest.includes(`--${name}`); }
function opt(name, def) {
  const i = rest.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i === -1) return def;
  const a = rest[i];
  if (a.includes('=')) return a.split('=').slice(1).join('=');
  const v = rest[i + 1];
  return v && !v.startsWith('--') ? v : def;
}
function num(name, def) { const v = parseFloat(opt(name, def)); return isFinite(v) && v > 0 ? v : def; }
const positional = rest.filter((a, i) => !a.startsWith('--') && !(i > 0 && rest[i - 1].startsWith('--') && !rest[i - 1].includes('=') && ['top', 'days', 'weeks', 'date', 'out', 'refresh'].includes(rest[i - 1].slice(2))));

if (cmd === 'statusline') {
  require('../src/statusline').main();
  return;
}
// Hot paths for the opt-in PreToolUse hook (pacr hooks install): keep them free of report code.
if (cmd === 'hook') {
  require('../src/hooks').main();
  return;
}
if (cmd === 'filter') {
  require('../src/hooks').filterMain(rest[0] || '');
  return;
}

util.setColorMode(process.env.NO_COLOR || flag('no-color') || !process.stdout.isTTY ? 'none' : 'ansi');
if (flag('color')) util.setColorMode('ansi');
const out = (s) => process.stdout.write(s + '\n');

const HELP = `pacr ${pkg.version} — Claude Code usage tracker (unofficial, local-only)

  pacr                    quick view: tokens + limits right now
  pacr today [--date YYYY-MM-DD]   hour-by-hour tokens and 5h window use
  pacr day YYYY-MM-DD     same, for any day     pacr yesterday
  pacr week [--last]      day-by-day, weekly limit projection, vs last week
  pacr month [--last]     calendar month: per week, day strip, vs last month, top projects
  pacr sessions [--top 10] [--days 7]   heaviest sessions, with flags
  pacr session <id>       one session: breakdown + timeline
  pacr branches [--days 30]   tokens per git branch (cost of a feature)
  pacr heatmap [--weeks 4]    which hours you burn the most
  pacr tips [--days 7]    ways to save tokens, from your own data
  pacr tools [--days 7]   biggest tool results (Bash commands, files read) + what to do
  pacr plan [--days 28]   limit hits and whether your plan fits
  pacr summary [--this]   weekly summary (last week by default)
  pacr alerts             alert settings + recent alerts
  pacr alerts test        send a test notification
  pacr budget daily|weekly <3M|off>   set your own token budget
  pacr config [key] [value]   view or change settings
  pacr export [--csv|--json] [--days 30] [--out file]
  pacr watch              background loop for alerts when Claude Code is closed
  pacr install [--refresh 30]   add the status line to Claude Code
  pacr uninstall          remove it (restores your previous one, removes the hook)
  pacr hooks install [--yes]   opt-in hook: trim test/build output to failures + summary
  pacr hooks status | off | on | uninstall
  pacr doctor             check setup

Data: reads ~/.claude/projects/*.jsonl, writes only to ~/.pacr. No network, no credentials.`;

function parseValue(v) {
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v === 'off' || v === 'null') return null;
  if (/^[\d.]+[kmb]?$/i.test(v)) return /[kmb]$/i.test(v) ? util.parseTok(v) : parseFloat(v);
  if (/^[\d.]+(,[\d.]+)+$/.test(v)) return v.split(',').map(Number);
  if (/^\[.*\]$/.test(v)) { try { return JSON.parse(v); } catch { /* keep as text */ } }
  return v;
}

function main() {
  const r = require('../src/reports');
  switch (cmd) {
    case null:
      if (flag('version') || flag('v')) return out(pkg.version);
      if (flag('help') || flag('h')) return out(HELP);
      return out(r.overview());
    case 'help': return out(HELP);
    case 'version': return out(pkg.version);
    case 'today': {
      const d = opt('date', null);
      const date = d ? util.parseDateArg(d) : null;
      if (d && date == null) return out('Use --date YYYY-MM-DD');
      return out(r.today({ date }));
    }
    case 'day': {
      const date = util.parseDateArg(positional[0]);
      if (date == null) return out('Usage: pacr day YYYY-MM-DD');
      return out(r.today({ date }));
    }
    case 'yesterday': return out(r.today({ date: util.startOfDay(util.startOfDay(Date.now()) - 1) }));
    case 'week': return out(r.week({ last: flag('last') }));
    case 'month': return out(r.month({ last: flag('last') }));
    case 'sessions': return out(r.sessions({ top: num('top', 10), days: num('days', 7) }));
    case 'session': return out(r.session({ id: positional[0] }));
    case 'branches': return out(r.branches({ days: num('days', 30) }));
    case 'heatmap': return out(r.heatmap({ weeks: num('weeks', 4) }));
    case 'tips': return out(r.tips({ days: num('days', 7) }));
    case 'tools': return out(r.tools({ days: num('days', 7), top: num('top', 15) }));
    case 'hooks': return hooksCmd();
    case 'plan': return out(r.plan({ days: num('days', 28) }));
    case 'summary':
      if (flag('notify')) { r.summaryNotify(); return; }
      return out(r.summary({ last: !flag('this') }));
    case 'alerts': {
      if (positional[0] === 'test') {
        const ok = require('../src/notify').send('pacr', 'Test notification: alerts are working.');
        return out(ok ? 'Sent. If nothing appeared, check your system notification settings.' : 'Could not send a notification on this system.');
      }
      return out(r.alertsView());
    }
    case 'budget': {
      const config = require('../src/config');
      const [which, val] = positional;
      if (!which) {
        const b = config.load().budget;
        return out(`daily: ${b.daily ? util.fmtTok(b.daily) : 'off'}   weekly: ${b.weekly ? util.fmtTok(b.weekly) : 'off'}\nset: pacr budget daily 3M   ·   remove: pacr budget daily off`);
      }
      if (!['daily', 'weekly'].includes(which)) return out('Use: pacr budget daily|weekly <tokens|off>');
      const v = val == null || val === 'off' ? null : util.parseTok(val);
      if (val && val !== 'off' && !v) return out(`Couldn't read "${val}". Examples: 3M, 500k, 15000000`);
      config.set(`budget.${which}`, v);
      return out(v ? `${which} budget set to ${util.fmtTok(v)} tokens.` : `${which} budget off.`);
    }
    case 'config': {
      const config = require('../src/config');
      const [key, val] = positional;
      if (!key) return out(JSON.stringify(config.load(), null, 2) + `\n\nfile: ${require('../src/paths').file('config.json')}`);
      if (val === undefined) return out(JSON.stringify(config.get(key), null, 2));
      config.set(key, parseValue(val));
      return out(`${key} = ${JSON.stringify(config.get(key))}`);
    }
    case 'export': return doExport();
    case 'watch': return watch();
    case 'install': {
      const res = require('../src/install').install({ refresh: num('refresh', 30) });
      out(res.msg);
      if (!res.ok) process.exitCode = 1;
      return;
    }
    case 'uninstall': {
      const res = require('../src/install').uninstall();
      out(res.msg);
      const h = require('../src/hooks').uninstall();
      if (h.removed) out(h.msg);
      if (!res.ok) process.exitCode = 1;
      return;
    }
    case 'doctor': return doctor();
    case 'json': {
      const st = require('../src/state').getState({});
      delete st.cfg;
      return out(JSON.stringify(st, null, 2));
    }
    default:
      out(`Unknown command "${cmd}".\n`);
      out(HELP);
      process.exitCode = 1;
  }
}

function hooksCmd() {
  const hooks = require('../src/hooks');
  const sub = positional[0] || 'status';
  const report = (res) => { out(res.msg); if (!res.ok) process.exitCode = 1; };
  switch (sub) {
    case 'install': {
      const st = hooks.status();
      out(`pacr will add this PreToolUse hook to ${st.path}:\n`);
      out(hooks.preview());
      out(`\nBefore simple test/build commands (npm test, npm run build, pnpm/yarn test|build, pytest, go test,
cargo test) run, it pipes their output through a filter that keeps failures, errors and the summary
(max ~${hooks.MAX_LINES} lines). Exit codes are kept. Other commands are never touched; on any error the command
runs unchanged. Your permission rules still apply. Full output: prefix the command with PACR_RAW=1.
settings.json is backed up first. Quick disable: pacr hooks off · remove: pacr hooks uninstall\n`);
      if (flag('yes') || flag('y')) return report(hooks.install());
      if (!process.stdin.isTTY) { out('Not a terminal: run  pacr hooks install --yes  to confirm.'); process.exitCode = 1; return; }
      const rl = require('readline').createInterface({ input: process.stdin, output: process.stdout });
      rl.question('Add it? [y/N] ', (a) => {
        rl.close();
        if (/^y(es)?$/i.test(a.trim())) report(hooks.install());
        else out('Nothing changed.');
      });
      return;
    }
    case 'uninstall': case 'remove': return report(hooks.uninstall());
    case 'off': hooks.setEnabled(false); return out('pacr hook off: commands run unfiltered. Turn back on: pacr hooks on');
    case 'on': {
      hooks.setEnabled(true);
      const st = hooks.status();
      return out(st.installed ? 'pacr hook on.' : 'pacr hook enabled, but not installed yet: run pacr hooks install');
    }
    case 'status': {
      const st = hooks.status();
      if (st.error) return out(`Couldn't read ${st.path}: ${st.error}`);
      return out(!st.installed ? 'pacr hook: not installed (pacr hooks install)'
        : st.enabled ? `pacr hook: on  ${util.c('d', st.path)}` : 'pacr hook: installed but off (pacr hooks on)');
    }
    default: out('Usage: pacr hooks install [--yes] | status | off | on | uninstall'); process.exitCode = 1;
  }
}

function doExport() {
  const logs = require('../src/logs');
  const days = num('days', 30);
  const { records } = logs.scan({ since: Date.now() - days * util.DAY });
  let body;
  if (flag('json')) {
    body = JSON.stringify(records.map((r) => ({ ...r, timestamp: new Date(r.ts).toISOString(), total: logs.total(r, true) })), null, 2);
  } else {
    const q = (s) => (/[",\n]/.test(String(s)) ? `"${String(s).replace(/"/g, '""')}"` : String(s));
    const rows = [['timestamp', 'session', 'project', 'branch', 'model', 'subagent', 'input', 'output', 'cache_write', 'cache_read', 'total'].join(',')];
    for (const r of records) {
      rows.push([new Date(r.ts).toISOString(), r.sid, r.cwd, r.branch, r.model, r.side, r.inp, r.out, r.cw, r.cr, logs.total(r, true)].map(q).join(','));
    }
    body = rows.join('\n') + '\n';
  }
  const file = opt('out', null);
  if (file) {
    fs.writeFileSync(file, body);
    out(`Wrote ${records.length} rows to ${path.resolve(file)}`);
  } else {
    process.stdout.write(body);
  }
}

function watch() {
  const { getState } = require('../src/state');
  const alerts = require('../src/alerts');
  const every = num('interval', 60) * 1000;
  out(`pacr watching for alerts every ${every / 1000}s (Ctrl+C to stop)`);
  const tick = () => {
    try {
      const st = getState({});
      const fired = alerts.evaluate(st);
      if (fired.length) out(`${util.fmtHM(Date.now())} fired: ${fired.join(', ')}`);
    } catch (e) { out(`error: ${e.message}`); }
  };
  tick();
  setInterval(tick, every);
}

function doctor() {
  const paths = require('../src/paths');
  const logs = require('../src/logs');
  const snapshots = require('../src/snapshots');
  const inst = require('../src/install').status();
  const ok = (b) => util.c(b ? 'g' : 'r', b ? '✓' : '✗');
  const warn = util.c('y', '!');
  const major = parseInt(process.versions.node, 10);
  out(`${ok(major >= 18)} Node.js ${process.versions.node}${major < 18 ? ' (needs 18+)' : ''}`);
  const dirs = paths.claudeDirs();
  out(`${ok(dirs.length)} Claude Code folder: ${dirs.join(', ') || 'not found (is Claude Code installed?)'}`);
  const files = logs.listFiles(0);
  const newest = files.reduce((x, f) => Math.max(x, f.mtime), 0);
  out(`${ok(files.length)} session logs: ${files.length} file${files.length === 1 ? '' : 's'}` + (newest ? `, newest ${util.fmtDur(Date.now() - newest)} ago` : ''));
  out(`${inst.installed ? ok(true) : warn} status line: ${inst.installed ? 'installed' : 'not installed (run: pacr install)'}  ${util.c('d', inst.path)}`);
  if (inst.error) out(`${ok(false)} settings.json: ${inst.error}`);
  if (inst.slash) out(`${inst.slash.exists ? ok(true) : warn} /pacr command: ${inst.slash.exists ? (inst.slash.ours ? 'installed' : 'your own file') : 'not installed (run: pacr install)'}  ${util.c('d', inst.slash.path)}`);
  const hk = require('../src/hooks').status();
  out(`${hk.active ? ok(true) : util.c('d', '·')} output filter hook: ${hk.active ? 'on' : hk.installed ? 'installed but off (pacr hooks on)' : 'off (optional: pacr hooks install)'}`);
  const latest = snapshots.latest();
  if (!latest) out(`${warn} limit data: none yet (appears after the status line runs in a Pro/Max session)`);
  else if (latest.f == null && latest.w == null) out(`${warn} limit data: status line runs, but no 5h/weekly limits (API-key login or before the first reply)`);
  else out(`${ok(true)} limit data: 5h ${util.fmtPct(latest.f)}, week ${util.fmtPct(latest.w)} — ${util.fmtDur(Date.now() - latest.t)} ago`);
  const n = require('../src/notify');
  const method = process.platform === 'darwin' ? 'osascript' : process.platform === 'win32' ? 'PowerShell toast' : n.isWSL() ? 'PowerShell toast (WSL)' : 'notify-send';
  out(`${ok(true)} notifications: ${method}  ${util.c('d', '(test: pacr alerts test)')}`);
  out(`${ok(true)} data folder: ${paths.dataDir()}`);
}

main();
