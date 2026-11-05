'use strict';
// Measures how big tool results are (they're sent back to the model as input on the next turn).
// Size is estimated as chars / 4, grouped by tool and target: Bash by normalized command, Read by file.
const fs = require('fs');
const os = require('os');
const logs = require('./logs');
const { projName } = require('./util');

const est = (chars) => Math.round(chars / 4);

// Text length of a tool_result's content (a string, or a list of text/image blocks).
function resultChars(content) {
  if (typeof content === 'string') return content.length;
  if (!Array.isArray(content)) return 0;
  let n = 0;
  for (const b of content) if (b && typeof b.text === 'string') n += b.text.length;
  return n;
}

const RUNNERS2 = new Set(['npm', 'pnpm', 'yarn', 'bun', 'npx', 'git', 'go', 'cargo', 'docker', 'kubectl', 'pip', 'pip3', 'uv', 'poetry', 'gh', 'make', 'dotnet', 'mvn', 'gradle', 'deno', 'brew']);
const SKIP = new Set(['cd', 'export', 'source', '.', 'set', 'pushd', 'popd', 'true', 'clear']);

// "cd app && FOO=1 npm run test -- --ci 2>&1 | tail -50" → "npm run test"
function normalizeCommand(cmd) {
  const parts = String(cmd || '').split(/&&|\|\||;|\n/).map((s) => s.trim()).filter(Boolean);
  for (const part of parts) {
    const seg = part.split('|')[0];
    const words = seg.trim().split(/\s+/).filter((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w));
    if (!words.length) continue;
    let w0 = words[0].replace(/^["']|["']$/g, '');
    w0 = w0.split(/[\\/]/).pop();
    if (SKIP.has(w0)) continue;
    const rest = words.slice(1).filter((w) => !w.startsWith('-'));
    if (/^python[\d.]*$/.test(w0) && words[1] === '-m' && words[2]) return words[2];
    if (w0 === 'npx' && rest[0]) return rest[0];
    if (RUNNERS2.has(w0) && rest[0]) {
      if (rest[0] === 'run' && rest[1]) return `${w0} run ${rest[1]}`;
      return `${w0} ${rest[0]}`;
    }
    return w0;
  }
  return '(other)';
}

const TESTBUILD = /\b(test|tests|build|pytest|jest|vitest|mocha|tsc|webpack|vite|rollup|esbuild|make|mvn|gradle|tox|rspec|phpunit|lint|check)\b/;
const NOISY_PATH = /(^|[\\/])(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|poetry\.lock|uv\.lock|Pipfile\.lock|Gemfile\.lock|composer\.lock|go\.sum)$|(^|[\\/])(dist|build|node_modules|\.next|out|coverage)[\\/]|\.min\.(js|css)$|\.log$|\.map$/;

const BIG_OUTPUT = 2000;   // avg tokens per call that counts as big test/build output
const BIG_FILE = 10000;    // one file read this large is worth grepping instead

function suggestion(row) {
  if (row.tool === 'Bash' && TESTBUILD.test(row.target) && row.avg >= BIG_OUTPUT) return 'filter with pacr hooks';
  if (row.tool === 'Read' && NOISY_PATH.test(row.target)) return 'block with permissions.deny';
  if (row.tool === 'Read' && row.avg >= BIG_FILE) return 'ask Claude to grep or read a range';
  return '';
}

// Files inside the project show as "<project>/<path>", so the same docs/API.md in two repos stays apart.
function displayPath(p, cwd) {
  p = String(p || '');
  if (cwd && p.startsWith(cwd + '/')) return `${projName(cwd)}/${p.slice(cwd.length + 1)}`;
  const home = os.homedir();
  if (home && p.startsWith(home)) return '~' + p.slice(home.length);
  return p;
}

// mcp__claude-in-chrome__browser_batch → tool "MCP claude-in-chrome", target "browser_batch".
function toolAndTarget(name, input, cwd) {
  const m = String(name || '').match(/^mcp__(.+?)__(.+)$/);
  if (m) return { tool: `MCP ${m[1]}`, target: m[2] };
  return { tool: name || '?', target: targetOf(name, input, cwd) };
}

function targetOf(name, input, cwd) {
  input = input || {};
  if (name === 'Bash') return normalizeCommand(input.command);
  if (name === 'Read') return displayPath(input.file_path, cwd) || '?';
  return '';
}

// Scan logs for tool calls and their results since `since`. Pure part (`group`) is split out for tests.
function collect({ since = 0, until = Infinity } = {}) {
  const uses = new Map();    // tool_use id → { tool, target }
  const results = new Map(); // tool_use id → chars
  for (const f of logs.listFiles(since)) {
    let txt;
    try { txt = fs.readFileSync(f.path, 'utf8'); } catch { continue; }
    for (const line of txt.split('\n')) {
      if (line.indexOf('"tool_use') === -1 && line.indexOf('"tool_result"') === -1) continue;
      let o;
      try { o = JSON.parse(line); } catch { continue; }
      const content = o && o.message && o.message.content;
      if (!Array.isArray(content)) continue;
      const ts = Date.parse(o.timestamp);
      for (const b of content) {
        if (!b || !b.type) continue;
        if (b.type === 'tool_use' && b.id && !uses.has(b.id)) {
          uses.set(b.id, toolAndTarget(b.name, b.input, o.cwd));
        } else if (b.type === 'tool_result' && b.tool_use_id && !results.has(b.tool_use_id)) {
          if (isFinite(ts) && (ts < since || ts >= until)) continue;
          results.set(b.tool_use_id, resultChars(b.content));
        }
      }
    }
  }
  const calls = [];
  for (const [id, chars] of results) {
    const u = uses.get(id) || { tool: '?', target: '' };
    calls.push({ tool: u.tool, target: u.target, tokens: est(chars) });
  }
  return calls;
}

function group(calls) {
  const m = new Map();
  for (const x of calls) {
    const k = `${x.tool}\0${x.target}`;
    const g = m.get(k) || { tool: x.tool, target: x.target, count: 0, total: 0 };
    g.count++;
    g.total += x.tokens;
    m.set(k, g);
  }
  const rows = [...m.values()].map((g) => ({ ...g, avg: Math.round(g.total / g.count) }));
  for (const r of rows) r.suggestion = suggestion(r);
  return rows.sort((a, b) => b.total - a.total);
}

module.exports = { collect, group, normalizeCommand, suggestion, resultChars, est };
