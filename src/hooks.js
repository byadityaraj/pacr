'use strict';
// Opt-in PreToolUse hook that trims the output of simple test/build commands, following
// "Offload processing to hooks" in https://code.claude.com/docs/en/costs.
//   hook:   `pacr hook` reads the tool call on stdin. For a simple test/build command it returns an
//           updatedInput that pipes the output through `pacr filter`. Anything else, or any error,
//           prints {} so the command runs unchanged. Permissions are not touched: the rewritten
//           command still goes through the normal permission flow.
//   filter: keeps failures, errors and the summary, capped at ~150 lines. Exit status survives
//           through `set -o pipefail`.
const fs = require('fs');
const path = require('path');
const { claudeSettingsPath, file } = require('./paths');
const { readJSON, writeJSON } = require('./store');

const BIN = path.resolve(__dirname, '..', 'bin', 'pacr.js').replace(/\\/g, '/');
const MAX_LINES = 150;

function nodeCmd(platform = process.platform) {
  // Same reasoning as the status line command in install.js.
  return platform === 'win32' ? 'node' : `"${process.execPath}"`;
}
function hookCommand(platform) { return `${nodeCmd(platform)} "${BIN}" hook`; }
function filterCommand(platform) { return `${nodeCmd(platform)} "${BIN}" filter`; }
const isOurs = (h) => !!h && typeof h.command === 'string' && /pacr\.js"? hook$/.test(h.command);

// ---------------------------------------------------------------- which commands
// Only bare runner invocations with plain arguments: no pipes, redirects, chaining, substitution,
// quotes or comments, and nothing that waits forever (watch mode) or runs in the background.
const RUNNER = /^(?:(?:npm|pnpm|yarn) (?:test|t|build|run (?:test|build)(?::[\w-]+)?)|npm run (?:test|build)(?::[\w-]+)?|pytest|python3? -m pytest|go test|cargo test)(?: [\w@%+=:,./*-]+)*$/;
function isFilterable(cmd) {
  if (typeof cmd !== 'string') return false;
  const c = cmd.trim().replace(/\s+/g, ' ');
  if (!RUNNER.test(c)) return false;
  if (/(^| )(--watch(All)?|-w|watch|--ui|--serve)( |=|$)/.test(c)) return false;
  return true;
}

// ---------------------------------------------------------------- permission rules
// The rewritten command no longer looks like the original to Claude Code's permission rules, so
// the hook checks the user's rules against the ORIGINAL command itself:
//   deny/ask rule matches → don't rewrite (Claude Code then applies that rule as usual)
//   allow rule matches    → rewrite and return "allow", so an allowed `npm test` doesn't start prompting
//   no rule matches       → rewrite only; the normal permission flow decides
// Matching errs on the safe side: allow rules match narrowly, deny/ask rules broadly.
function settingsFiles(cwd) {
  const out = [claudeSettingsPath(), path.join(path.dirname(claudeSettingsPath()), 'settings.local.json')];
  for (const d of new Set([process.env.CLAUDE_PROJECT_DIR, cwd].filter(Boolean))) {
    out.push(path.join(d, '.claude', 'settings.json'), path.join(d, '.claude', 'settings.local.json'));
  }
  if (process.platform === 'darwin') out.push('/Library/Application Support/ClaudeCode/managed-settings.json');
  else if (process.platform === 'win32') out.push('C:\\Program Files\\ClaudeCode\\managed-settings.json');
  else out.push('/etc/claude-code/managed-settings.json');
  return out;
}

// Returns { allow, deny, ask } rule lists, or null if a settings file can't be read (then: hands off).
function loadRules(cwd) {
  const rules = { allow: [], deny: [], ask: [] };
  for (const f of settingsFiles(cwd)) {
    if (!fs.existsSync(f)) continue;
    let s;
    try { s = readSettings(f); } catch { return null; }
    const pm = (s && s.permissions) || {};
    for (const k of ['allow', 'deny', 'ask']) if (Array.isArray(pm[k])) rules[k].push(...pm[k].filter((r) => typeof r === 'string'));
  }
  return rules;
}

const reEsc = (x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
// Does a permission rule like "Bash(npm test:*)" cover this command? broad = for deny/ask rules.
function ruleMatches(rule, cmd, broad) {
  const m = String(rule).trim().match(/^Bash(?:\((.*)\))?$/s);
  if (!m) return false;
  const p = m[1] == null ? '*' : m[1].trim();
  if (p === '' || p === '*') return true;
  if (p.endsWith(':*')) {
    const pre = p.slice(0, -2);
    return broad ? cmd.startsWith(pre) : cmd === pre || cmd.startsWith(pre + ' ');
  }
  if (p.includes('*')) {
    let src = p.split('*').map(reEsc).join('.*');
    if (broad) src = src.replace(/ \.\*$/, '( .*)?'); // "npm test *" also covers bare "npm test"
    return new RegExp(`^${src}$`, 's').test(cmd);
  }
  return broad ? cmd === p || cmd.startsWith(p + ' ') : cmd === p;
}

function decide(cmd, rules) {
  if (!rules) return 'skip';
  if ([...rules.deny, ...rules.ask].some((r) => ruleMatches(r, cmd, true))) return 'skip';
  return rules.allow.some((r) => ruleMatches(r, cmd, false)) ? 'allow' : 'rewrite';
}

// ---------------------------------------------------------------- the hook itself
// Returns the JSON string to print. Never throws.
function handle(raw, { cfg = null, platform, rules } = {}) {
  try {
    if (cfg == null) cfg = require('./config').load();
    if (cfg.hooks && cfg.hooks.enabled === false) return '{}';
    const input = JSON.parse(raw);
    const ti = input && input.tool_input;
    if (!input || input.tool_name !== 'Bash' || !ti || ti.run_in_background) return '{}';
    if (!isFilterable(ti.command)) return '{}';
    // The filter must be runnable, or the command's output would be lost.
    if (!fs.existsSync(BIN)) return '{}';
    if ((platform || process.platform) !== 'win32' && !fs.existsSync(process.execPath)) return '{}';
    const cmd = ti.command.trim();
    const verdict = decide(cmd.replace(/\s+/g, ' '), rules === undefined ? loadRules(input.cwd) : rules);
    if (verdict === 'skip') return '{}';
    // isFilterable allows no quotes or $, so the command can go inside double quotes as is.
    const rewritten = `(set -o pipefail; ${cmd} 2>&1 | ${filterCommand(platform)} "${cmd}")`;
    const out = { hookEventName: 'PreToolUse', updatedInput: { ...ti, command: rewritten } };
    if (verdict === 'allow') out.permissionDecision = 'allow';
    return JSON.stringify({ hookSpecificOutput: out });
  } catch {
    return '{}';
  }
}

function main() {
  let raw = '';
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    try { process.stdout.write(handle(raw) + '\n'); } catch { /* ignore */ }
    process.exitCode = 0;
  };
  try {
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => { raw += d; });
    process.stdin.on('end', finish);
    process.stdin.on('error', finish);
    setTimeout(finish, 3000).unref(); // never hold up a command
  } catch { finish(); }
}

// ---------------------------------------------------------------- the output filter
const BAD = /\b(fail(s|ed|ure|ures|ing)?|errors?|exception|panic(ked)?|traceback|assert(ion)?(error)?|segfault|fatal|undefined reference|cannot find|not found|expected|received)\b|✗|✕|✖|×|FAIL|ERR!|E\s{2,}|^\s*E\s|--- FAIL|error\[E\d+\]|error TS\d+/i;
const SUMMARY = /^\s*(tests?|test suites?|test files|suites?|snapshots|time|duration|ran \d+|ok|fail|pass(ed)?|failed|errors?|warnings?|test result|=+ .* =+|-+ .* -+|\d+ (passing|failing|pending|passed|failed|skipped|errors?))\b|\b\d+ (passed|failed|passing|failing|skipped|errors?)\b|^(ok|FAIL|PASS)\s+\S+|^Finished|^(Compiled|Built|Build) /i;

// Pick the lines worth keeping from full output. Pure, for tests.
function filterLines(text, { max = MAX_LINES, cmd = '' } = {}) {
  const lines = String(text).replace(/\r\n/g, '\n').replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  if (lines.length <= max) return lines;
  const keep = new Array(lines.length).fill(false);
  lines.forEach((l, i) => {
    if (BAD.test(l)) for (let j = Math.max(0, i - 2); j <= Math.min(lines.length - 1, i + 6); j++) keep[j] = true;
    else if (SUMMARY.test(l)) keep[i] = true;
  });
  for (let i = Math.max(0, lines.length - 15); i < lines.length; i++) keep[i] = true; // summary is usually at the end
  let idx = [];
  keep.forEach((k, i) => { if (k) idx.push(i); });
  // Over the cap: keep the first failures and the end (where the summary is).
  const tail = 30;
  if (idx.length > max - 2) idx = [...idx.slice(0, max - 2 - tail), ...idx.slice(-tail)];
  const out = [];
  let prev = -1;
  for (const i of idx) {
    if (i > prev + 1) out.push(`… ${i - prev - 1} lines hidden by pacr`);
    out.push(lines[i]);
    prev = i;
  }
  if (prev < lines.length - 1) out.push(`… ${lines.length - 1 - prev} lines hidden by pacr`);
  const rerun = cmd ? `PACR_RAW=1 ${cmd}` : 'PACR_RAW=1 <command>';
  out.push(`[pacr: showing ${out.filter((l) => !l.startsWith('… ')).length} of ${lines.length} lines. Full output: ${rerun}]`);
  return out;
}

function filterMain(cmd) {
  const chunks = [];
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    const raw = Buffer.concat(chunks).toString('utf8');
    let text;
    try { text = filterLines(raw, { cmd }).join('\n') + '\n'; } catch { text = raw; } // on any error: everything, unfiltered
    process.stdout.on('error', () => {});
    process.stdout.write(text);
    process.exitCode = 0;
  };
  process.stdin.on('data', (d) => chunks.push(d));
  process.stdin.on('end', finish);
  process.stdin.on('error', finish);
}

// ---------------------------------------------------------------- settings.json
function readSettings(p) {
  if (!fs.existsSync(p)) return {};
  const raw = fs.readFileSync(p, 'utf8');
  if (!raw.trim()) return {};
  return JSON.parse(raw); // throws on invalid JSON: we never overwrite a file we can't parse
}

const ENTRY = () => ({ matcher: 'Bash', hooks: [{ type: 'command', command: hookCommand(), timeout: 10 }] });

function findOurs(s) {
  const list = s && s.hooks && Array.isArray(s.hooks.PreToolUse) ? s.hooks.PreToolUse : [];
  return list.filter((g) => g && Array.isArray(g.hooks) && g.hooks.some(isOurs));
}

// Text shown before install: exactly what gets added.
function preview() {
  return JSON.stringify({ hooks: { PreToolUse: [ENTRY()] } }, null, 2);
}

function removeOurs(s) {
  if (!s.hooks || !Array.isArray(s.hooks.PreToolUse)) return false;
  let changed = false;
  const kept = [];
  for (const g of s.hooks.PreToolUse) {
    if (!g || !Array.isArray(g.hooks) || !g.hooks.some(isOurs)) { kept.push(g); continue; }
    changed = true;
    const others = g.hooks.filter((h) => !isOurs(h));
    if (others.length) kept.push({ ...g, hooks: others });
  }
  if (!changed) return false;
  if (kept.length) s.hooks.PreToolUse = kept;
  else delete s.hooks.PreToolUse;
  if (!Object.keys(s.hooks).length) delete s.hooks;
  return true;
}

function install() {
  const p = claudeSettingsPath();
  let s;
  try { s = readSettings(p); } catch (e) {
    return { ok: false, msg: `Couldn't parse ${p} (${e.message}). Fix it, or add this yourself:\n${preview()}` };
  }
  fs.mkdirSync(path.dirname(p), { recursive: true });
  if (fs.existsSync(p)) fs.copyFileSync(p, p + '.pacr-hooks.bak');
  removeOurs(s); // replace an older entry (e.g. pacr moved)
  if (!s.hooks || typeof s.hooks !== 'object') s.hooks = {};
  if (!Array.isArray(s.hooks.PreToolUse)) s.hooks.PreToolUse = [];
  s.hooks.PreToolUse.push(ENTRY());
  fs.writeFileSync(p, JSON.stringify(s, null, 2) + '\n');
  setEnabled(true);
  return { ok: true, msg: `Hook added to ${p}` + (fs.existsSync(p + '.pacr-hooks.bak') ? `\nBackup: ${p}.pacr-hooks.bak` : '') + '\nStart a new Claude Code session (or check with /hooks) to use it. Quick disable: pacr hooks off' };
}

function uninstall() {
  const p = claudeSettingsPath();
  let s;
  try { s = readSettings(p); } catch (e) { return { ok: false, msg: `Couldn't parse ${p}: ${e.message}` }; }
  if (!removeOurs(s)) return { ok: true, removed: false, msg: 'The pacr hook is not installed.' };
  fs.writeFileSync(p, JSON.stringify(s, null, 2) + '\n');
  return { ok: true, removed: true, msg: 'Removed the pacr hook.' };
}

function setEnabled(on) {
  const cfgPath = file('config.json');
  const raw = readJSON(cfgPath, {});
  raw.hooks = { ...(raw.hooks || {}), enabled: on };
  writeJSON(cfgPath, raw);
}

function status() {
  const p = claudeSettingsPath();
  let installed = false;
  let error = null;
  try { installed = findOurs(readSettings(p)).length > 0; } catch (e) { error = e.message; }
  const cfg = require('./config').load();
  const enabled = !(cfg.hooks && cfg.hooks.enabled === false);
  return { path: p, installed, enabled, active: installed && enabled, error };
}

module.exports = { isFilterable, ruleMatches, decide, handle, main, filterLines, filterMain, install, uninstall, status, setEnabled, preview, hookCommand, MAX_LINES };
