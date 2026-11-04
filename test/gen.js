'use strict';
// Generates a fake ~/.claude with realistic session logs and pacr snapshots,
// so every command can be tested without real usage data.
const fs = require('fs');
const path = require('path');

function rng(seed) { let s = seed; return () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296; }

function generate(home, now = Date.now()) {
  const rand = rng(42);
  fs.rmSync(home, { recursive: true, force: true });
  const projRoot = path.join(home, '.claude', 'projects');
  const projects = [
    { cwd: '/home/dev/shop-api', branches: ['feature/payment-retry', 'main', 'fix/webhook-timeout'] },
    { cwd: '/home/dev/dashboard', branches: ['main', 'feature/charts'] },
    { cwd: '/home/dev/infra', branches: ['main'] }
  ];
  // CLAUDE.md that is too big, and an unused MCP server
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'CLAUDE.md'), 'x'.repeat(26000));
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { github: {}, figma: {}, linear: {} } }));

  let msgN = 0;
  // total/byDay include cache reads; fresh/freshByDay don't (the default totals).
  const expected = { total: 0, byDay: {}, fresh: 0, freshByDay: {} };
  const DAY = 86400000;
  for (let d = 27; d >= 0; d--) {
    const day = new Date(now - d * DAY); day.setHours(0, 0, 0, 0);
    if (day.getDay() === 0 && rand() < 0.6) continue; // quieter Sundays
    const nSessions = 1 + Math.floor(rand() * 3);
    for (let si = 0; si < nSessions; si++) {
      const p = projects[Math.floor(rand() * projects.length)];
      const branch = p.branches[Math.floor(rand() * p.branches.length)];
      const sid = `${(d * 10 + si).toString(16).padStart(4, '0')}${Math.floor(rand() * 1e8).toString(16)}-aaaa-bbbb-cccc-${String(d).padStart(12, '0')}`;
      const startHour = 9 + Math.floor(rand() * 8);
      let ts = day.getTime() + startHour * 3600000 + Math.floor(rand() * 3600000);
      if (ts > now - 60000) continue;
      const long = rand() < 0.25;
      const nMsgs = long ? 70 + Math.floor(rand() * 60) : 8 + Math.floor(rand() * 40);
      const opus = rand() < 0.6;
      const model = opus ? 'claude-opus-4-8' : 'claude-sonnet-4-6';
      const dir = path.join(projRoot, p.cwd.replace(/\//g, '-'));
      fs.mkdirSync(dir, { recursive: true });
      const lines = [];
      let ctx = 15000;
      for (let i = 0; i < nMsgs; i++) {
        ts += 20000 + Math.floor(rand() * 90000);
        let idle = false;
        if (rand() < 0.06) { ts += 7 * 60000 + Math.floor(rand() * 20 * 60000); idle = true; }
        if (ts > now - 30000) break;
        ctx += 1500 + Math.floor(rand() * 5000);
        const side = rand() < 0.12;
        const usage = {
          input_tokens: 5 + Math.floor(rand() * 50),
          output_tokens: 200 + Math.floor(rand() * 1500),
          cache_creation_input_tokens: idle ? ctx : 1000 + Math.floor(rand() * 4000),
          cache_read_input_tokens: idle ? 0 : ctx
        };
        const id = `msg_${++msgN}`;
        const reqId = `req_${msgN}`;
        const base = {
          type: 'assistant', sessionId: sid, cwd: p.cwd, gitBranch: branch, isSidechain: side,
          timestamp: new Date(ts).toISOString(), requestId: reqId,
          message: { id, model, role: 'assistant', usage, content: [{ type: 'text', text: 'ok' }] }
        };
        if (rand() < 0.15) base.message.content.push({ type: 'tool_use', name: 'mcp__github__get_issue', id: 't' + msgN });
        // Split logging: same response written twice (first with partial output tokens)
        if (rand() < 0.3) {
          const partial = JSON.parse(JSON.stringify(base));
          partial.message.usage.output_tokens = 10;
          lines.push(JSON.stringify(partial));
        }
        lines.push(JSON.stringify(base));
        lines.push(JSON.stringify({ type: 'user', sessionId: sid, timestamp: new Date(ts + 1000).toISOString(), message: { role: 'user', content: 'next' } }));
        const tot = usage.input_tokens + usage.output_tokens + usage.cache_creation_input_tokens + usage.cache_read_input_tokens;
        expected.total += tot;
        const k = new Date(ts).toDateString();
        expected.byDay[k] = (expected.byDay[k] || 0) + tot;
        const fresh = tot - usage.cache_read_input_tokens;
        expected.fresh += fresh;
        expected.freshByDay[k] = (expected.freshByDay[k] || 0) + fresh;
      }
      fs.appendFileSync(path.join(dir, `${sid}.jsonl`), lines.join('\n') + '\n');
    }
  }

  // Snapshots: 5h windows that fill during work hours, weekly % climbing over the week.
  const tp = path.join(home, '.pacr');
  fs.mkdirSync(tp, { recursive: true });
  const snaps = [];
  let weekPct = 0;
  let weekReset = now + 2.3 * DAY;
  while (weekReset - 7 * DAY > now - 27 * DAY) weekReset -= 7 * DAY;
  for (let d = 27; d >= 0; d--) {
    const day = new Date(now - d * DAY); day.setHours(0, 0, 0, 0);
    const winStart = day.getTime() + 10 * 3600000;
    const winReset = winStart + 5 * 3600000;
    const heavy = rand() < 0.3;
    let f = 0;
    for (let t = winStart; t < winReset && t < now; t += 60000) {
      if (t >= weekReset) { weekReset += 7 * DAY; weekPct = 0; }
      if (t - winStart < 3 * 3600000) { f = Math.min(100, f + (heavy ? 0.6 : 0.25) * rand() * 2); weekPct = Math.min(100, weekPct + 0.012 * rand() * 2); }
      snaps.push({ t, sid: null, m: 'Opus', mid: 'claude-opus-4-8', f: +f.toFixed(1), fr: winReset, w: +weekPct.toFixed(1), wr: weekReset, c: 40, usd: null, p: '/home/dev/shop-api' });
    }
  }
  fs.writeFileSync(path.join(tp, 'snapshots.jsonl'), snaps.map((s) => JSON.stringify(s)).join('\n') + '\n');
  return { expected, weekReset };
}

module.exports = { generate };

if (require.main === module) {
  const home = process.argv[2] || path.join(__dirname, '..', '.testhome');
  const r = generate(home);
  console.log('generated in', home, 'expected total', r.expected.total);
}
