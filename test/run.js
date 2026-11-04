'use strict';
// Smoke + correctness tests against generated data. Run: npm test
const path = require('path');
const os = require('os');
const fs = require('fs');
const { execFileSync } = require('child_process');
const assert = require('assert');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pacr-test-'));
const { generate } = require('./gen');
const now = Date.now();
const { expected, weekReset } = generate(home, now);
const BIN = path.join(__dirname, '..', 'bin', 'pacr.js');
const env = { ...process.env, HOME: home, USERPROFILE: home, PACR_NO_NOTIFY: '1', PACR_HOME: path.join(home, '.pacr'), NO_COLOR: '' };
delete env.CLAUDE_CONFIG_DIR;
delete env.XDG_CONFIG_HOME;

function run(args, input) {
  return execFileSync(process.execPath, [BIN, ...args], { env, input, encoding: 'utf8' });
}

let pass = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ', name); } catch (e) { console.log('  FAIL', name, '\n', e.stack); process.exitCode = 1; }
}

// Scan totals match generator (dedupe of split lines keeps the larger usage).
test('scan total matches generated data', () => {
  process.env.HOME = home; process.env.PACR_HOME = env.PACR_HOME;
  delete require.cache[require.resolve('../src/paths')];
  const out = run(['export', '--json', '--days', '40']);
  const recs = JSON.parse(out);
  const sum = recs.reduce((x, r) => x + r.total, 0);
  assert.strictEqual(sum, expected.total);
});

const input = (f, w, c, sid = 'live-session-1') => JSON.stringify({
  session_id: sid, model: { id: 'claude-opus-4-8', display_name: 'Opus' },
  workspace: { current_dir: '/home/dev/shop-api', project_dir: '/home/dev/shop-api' },
  cost: { total_cost_usd: 6.2 }, context_window: { used_percentage: c },
  rate_limits: { five_hour: { used_percentage: f, resets_at: Math.floor((now + 102 * 60000) / 1000) }, seven_day: { used_percentage: w, resets_at: Math.floor(weekReset / 1000) } }
});

test('status line: normal', () => {
  const o = run(['statusline'], input(42, 38, 20));
  const plain = o.replace(/\x1b\[[0-9;]*m/g, '');
  assert.match(plain, /^hour \S+ · today \S+ · week \S+\n5h .* 42% resets 1h4[12]m  │  week .* 38% resets/);
  assert.strictEqual(plain.trim().split('\n').length, 2);
});

test('rollup today equals scan today (fresh tokens, cache reads separate)', () => {
  const st = JSON.parse(run(['json']));
  const k = new Date(now).toDateString();
  assert.ok(expected.freshByDay[k] > 0 && expected.byDay[k] > expected.freshByDay[k], 'generator has cache reads today');
  assert.strictEqual(st.tokens.today, expected.freshByDay[k]);
  assert.strictEqual(st.tokens.cached.today, expected.byDay[k] - expected.freshByDay[k]);
});

test('countCacheReads true brings back totals with cache reads', () => {
  run(['config', 'countCacheReads', 'true']);
  try {
    const st = JSON.parse(run(['json']));
    assert.strictEqual(st.tokens.today, expected.byDay[new Date(now).toDateString()]);
    assert.strictEqual(st.tokens.cached, null);
    assert.doesNotMatch(run(['today']), /cached/);
  } finally {
    run(['config', 'countCacheReads', 'false']);
  }
});

test('reports show cache reads as a separate figure; status line does not', () => {
  assert.match(run(['today']), /total \S+ tokens · \+\S+ cached · /);
  assert.match(run(['week']), /total \S+  · \+\S+ cached  · avg/);
  assert.match(run(['week']), /^busiest \w{3}  · top project /m);
  assert.match(run([]), /^cached \(not counted above\): hour \S+ · today \S+ · week \S+$/m);
  assert.doesNotMatch(run(['statusline'], input(42, 38, 20)), /cached/);
});

test('status line: red with /compact tip', () => {
  const plain = run(['statusline'], input(93, 44, 72)).replace(/\x1b\[[0-9;]*m/g, '');
  assert.match(plain, /⚠ .* — try \/compact \(ctx 72%\)/);
});

test('status line: red with /model tip when context small', () => {
  const plain = run(['statusline'], input(93, 44, 20)).replace(/\x1b\[[0-9;]*m/g, '');
  assert.match(plain, /try \/model sonnet/);
});

test('status line: API key user (no rate limits)', () => {
  const plain = run(['statusline'], JSON.stringify({ session_id: 'x', model: { display_name: 'Sonnet' }, context_window: { used_percentage: 30 }, cost: { total_cost_usd: 1.5 } }))
    .replace(/\x1b\[[0-9;]*m/g, '');
  assert.match(plain, /ctx .* 30%\s+│\s+session \$1\.50/);
});

test('status line: empty / garbage input never crashes', () => {
  run(['statusline'], '');
  run(['statusline'], 'not json');
});

test('burn rate warning from snapshot history', () => {
  // write history in the same 5h window: 50% -> 70% over 20 minutes
  const fr = Math.floor((now + 150 * 60000) / 1000) * 1000;
  const lines = [];
  for (let i = 20; i >= 1; i--) lines.push(JSON.stringify({ t: now - i * 60000, sid: 's', f: 70 - i, fr, w: 40, wr: weekReset, c: 30 }));
  fs.appendFileSync(path.join(home, '.pacr', 'snapshots.jsonl'), lines.join('\n') + '\n');
  const inp = JSON.parse(input(71, 40, 30));
  inp.rate_limits.five_hour.resets_at = fr / 1000;
  const plain = run(['statusline'], JSON.stringify(inp)).replace(/\x1b\[[0-9;]*m/g, '');
  assert.match(plain, /burn rate high — at this pace you hit the 5h limit in ~\d+m/);
});

test('alerts were recorded', () => {
  const a = fs.readFileSync(path.join(home, '.pacr', 'alerts.jsonl'), 'utf8');
  assert.match(a, /5-hour limit at 9\d%/);
  assert.match(a, /Session passed \$5/);
  assert.match(a, /Burn rate high/);
});

for (const args of [[], ['today'], ['week'], ['week', '--last'], ['month'], ['month', '--last'], ['yesterday'], ['sessions'], ['branches'], ['heatmap'], ['tips'], ['plan'], ['summary'], ['alerts'], ['doctor'], ['budget'], ['config']]) {
  test(`command: pacr ${args.join(' ')}`, () => {
    const o = run(args);
    assert.ok(o.length > 20, 'output too short');
    assert.doesNotMatch(o, /NaN|undefined|Infinity/);
  });
}

test('session detail by prefix', () => {
  const recs = JSON.parse(run(['export', '--json', '--days', '40']));
  const sid = recs[recs.length - 1].sid.slice(0, 8);
  const o = run(['session', sid]);
  assert.match(o, /timeline/);
  assert.doesNotMatch(o, /NaN|undefined/);
});

test('budget set + shows in status line', () => {
  run(['budget', 'daily', '1k']);
  const plain = run(['statusline'], input(30, 20, 10)).replace(/\x1b\[[0-9;]*m/g, '');
  assert.match(plain, /today \S+\/1k/);
  assert.match(plain, /daily budget of 1k reached/);
  run(['budget', 'daily', 'off']);
});

test('install / uninstall keep other settings and restore previous status line', () => {
  const sp = path.join(home, '.claude', 'settings.json');
  fs.writeFileSync(sp, JSON.stringify({ model: 'opus', statusLine: { type: 'command', command: 'my-old-line' } }));
  run(['install']);
  let s = JSON.parse(fs.readFileSync(sp, 'utf8'));
  assert.strictEqual(s.model, 'opus');
  assert.match(s.statusLine.command, /pacr\.js" statusline$/);
  assert.strictEqual(s.statusLine.refreshInterval, 30);
  const slash = path.join(home, '.claude', 'commands', 'pacr.md');
  assert.match(fs.readFileSync(slash, 'utf8'), /!`pacr \$ARGUMENTS`/);
  run(['uninstall']);
  s = JSON.parse(fs.readFileSync(sp, 'utf8'));
  assert.strictEqual(s.statusLine.command, 'my-old-line');
  assert.ok(!fs.existsSync(slash), 'uninstall removes the /pacr command it added');
});

test('install never overwrites a /pacr command the user wrote', () => {
  const slash = path.join(home, '.claude', 'commands', 'pacr.md');
  fs.mkdirSync(path.dirname(slash), { recursive: true });
  fs.writeFileSync(slash, 'my own command');
  assert.match(run(['install']), /left as is/);
  run(['uninstall']);
  assert.strictEqual(fs.readFileSync(slash, 'utf8'), 'my own command');
  fs.unlinkSync(slash);
});

test('windows status line command uses bare node + forward slashes', () => {
  const cmd = require('../src/install').command('win32');
  assert.match(cmd, /^node "[^"\\]+pacr\.js" statusline$/);
});

test('session growth counts context incl. cache reads, even when totals leave them out', () => {
  const A = require('../src/analyze');
  // 40 messages whose fresh tokens shrink while the cached context grows.
  const recs = Array.from({ length: 40 }, (_, i) => ({
    ts: now - (40 - i) * 60000, sid: 'g', cwd: '/x', branch: '', model: 'opus', side: false,
    inp: 10, out: 100, cw: i < 20 ? 5000 : 500, cr: i < 20 ? 20000 : 200000, tools: []
  }));
  const s = A.sessionStats(recs, [], false)[0];
  assert.ok(s.growth > 5, `growth ${s.growth}`);
});

test('month: weeks split at Monday, totals add up, previous month compared over the same days', () => {
  const R = require('../src/reports');
  // March 2026: Sun Mar 1 is its own week row, Mon Mar 2 starts the next one.
  const start = new Date(2026, 2, 1).getTime();
  const end = new Date(2026, 3, 1).getTime();
  const prevStart = new Date(2026, 1, 1).getTime();
  const at = (y, mo, d, h) => new Date(y, mo, d, h).getTime();
  const rec = (ts, inp, cr, extra = {}) => ({ ts, sid: extra.sid || 's1', cwd: extra.cwd || '/p/app', branch: extra.branch || 'main', model: 'opus', side: false, inp, out: 0, cw: 0, cr, tools: [] });
  const records = [
    rec(at(2026, 1, 3, 10), 50, 0),                    // Feb 3: inside "same days so far"
    rec(at(2026, 1, 20, 10), 999, 0),                  // Feb 20: after it, not compared
    rec(at(2026, 2, 1, 23), 100, 1000),                // Sun Mar 1, late evening
    rec(at(2026, 2, 2, 0), 200, 2000, { branch: 'feat-x', cwd: '/p/api' }), // Mon Mar 2, just after midnight
    rec(at(2026, 2, 3, 9), 300, 0, { sid: 's2', cwd: '/p/api' })
  ];
  const snaps = [{ t: at(2026, 2, 2, 12), f: 99, fr: at(2026, 2, 2, 15), w: 62, wr: at(2026, 2, 8, 9) }];
  const now = at(2026, 2, 3, 12);
  const m = R.monthData({ records, snaps, start, end, prevStart, now, retentionDays: 9999 });
  assert.strictEqual(m.weeks.length, 6);
  assert.deepStrictEqual([m.weeks[0].start, m.weeks[0].end], [start, at(2026, 2, 2, 0)]);
  assert.strictEqual(m.weeks[0].tokens, 100);
  assert.strictEqual(m.weeks[0].cached, 1000);
  assert.strictEqual(m.weeks[1].tokens, 500);
  assert.strictEqual(m.weeks[1].hits, 1);
  assert.strictEqual(m.weeks[1].weekPeak, 62);
  assert.strictEqual(m.weeks[0].weekPeak, null);
  assert.ok(m.weeks[2].future && !m.weeks[1].future);
  assert.strictEqual(m.tokens, m.weeks.reduce((x, w) => x + w.tokens, 0));
  assert.strictEqual(m.days.length, 31);
  assert.deepStrictEqual(m.days.slice(0, 3).map((d) => d.tokens), [100, 200, 300]);
  assert.strictEqual(m.prev.tokens, 50);
  assert.strictEqual(m.prev.partial, false);
  assert.deepStrictEqual(m.projects[0], ['api', 500]);
  assert.deepStrictEqual(m.branches.map((b) => b[0]), ['main', 'feat-x']);
  assert.strictEqual(m.sessions, 2);
  // With 30-day log retention, February is flagged as possibly incomplete.
  assert.strictEqual(R.monthData({ records, snaps, start, end, prevStart, now, retentionDays: 30 }).prev.partial, true);
});

test('month / day / yesterday commands', () => {
  const plain = (a) => run(a).replace(/\x1b\[[0-9;]*m/g, '');
  const mo = plain(['month']);
  assert.match(mo, /^This month · \w+ \d{4}   total \S+ tokens · \+\S+ cached · \d+ sessions? · \d+ active days?/);
  assert.match(mo, /^week +tokens +cached +5h limit hits +weekly peak +share$/m);
  assert.match(mo, /^days  1 .+ (28|29|30|31)$/m);
  assert.match(mo, /^vs \w{3} /m);
  assert.doesNotMatch(mo, /monthly limit/i);
  assert.match(plain(['month', '--last']), /^Last month · /);
  const d = new Date(now - 86400000);
  const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  assert.strictEqual(plain(['day', ymd]), plain(['today', '--date', ymd]));
  assert.strictEqual(plain(['yesterday']), plain(['day', ymd]));
  assert.match(plain(['yesterday']), /^Yesterday · /);
  assert.match(plain(['day', 'nope']), /Usage: pacr day YYYY-MM-DD/);
});

test('piping into a closed reader (| head) exits quietly', () => {
  const { spawnSync } = require('child_process');
  const r = spawnSync('sh', ['-c', `"${process.execPath}" "${BIN}" help | head -1`], { env, encoding: 'utf8' });
  assert.strictEqual(r.stderr, '');
});

test('fmtTok formatting', () => {
  const { fmtTok, parseTok } = require('../src/util');
  assert.deepStrictEqual([0, 999, 1500, 12345, 999999, 2410000, 6000000, 70500000, 1.2e9].map(fmtTok),
    ['0', '999', '1.5k', '12k', '1M', '2.41M', '6M', '70.5M', '1.20B']);
  assert.strictEqual(parseTok('3M'), 3000000);
  assert.strictEqual(parseTok('500k'), 500000);
});

test('csv export', () => {
  const o = run(['export', '--csv', '--days', '3']);
  assert.match(o.split('\n')[0], /^timestamp,session,project,branch,model/);
});

console.log(`\n${pass} passed${process.exitCode ? ', some FAILED' : ''}`);
if (!process.env.KEEP) fs.rmSync(home, { recursive: true, force: true });
else console.log('test home kept at', home);
