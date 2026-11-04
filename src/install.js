'use strict';
// Adds / removes the pacr status line in Claude Code's settings.json, and the /pacr slash command.
const fs = require('fs');
const path = require('path');
const { claudeSettingsPath, file } = require('./paths');
const { readJSON, writeJSON } = require('./store');

function command(platform = process.platform) {
  const bin = path.resolve(__dirname, '..', 'bin', 'pacr.js').replace(/\\/g, '/');
  // Windows: Claude Code runs this through Git Bash or PowerShell. A bare `node` works in both
  // (a quoted program path doesn't run in PowerShell). Forward slashes survive Git Bash.
  if (platform === 'win32') return `node "${bin}" statusline`;
  // macOS/Linux: absolute node path, so it works even when nvm/fnm isn't loaded in that shell.
  return `"${process.execPath}" "${bin}" statusline`;
}

// /pacr inside Claude Code: runs pacr and shows the output. The marker line lets us update or
// remove only a file we wrote, never one the user made.
const SLASH_MARKER = '<!-- installed by pacr -->';
const SLASH_COMMAND = `---
description: Show Claude Code token usage and limits from pacr
argument-hint: "[today | week | sessions | tips | plan | alerts | doctor | ...]"
allowed-tools: Bash(pacr:*)
---
${SLASH_MARKER}

Output of \`pacr $ARGUMENTS\`:

!\`pacr $ARGUMENTS\`

Show this output to the user as-is in a code block. Then add at most 2 short lines: the one thing that stands out (e.g. close to a limit, a heavy session, a tip that applies right now). Don't run other commands unless the user asks.
`;

function slashCommandPath() {
  return path.join(path.dirname(claudeSettingsPath()), 'commands', 'pacr.md');
}

function ours(p) {
  try { return fs.readFileSync(p, 'utf8').includes(SLASH_MARKER); } catch { return false; }
}

// Returns 'installed', 'updated', 'kept' (a /pacr of the user's own is already there) or 'failed'.
function installSlashCommand() {
  const p = slashCommandPath();
  const existed = fs.existsSync(p);
  if (existed && !ours(p)) return 'kept';
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, SLASH_COMMAND);
    return existed ? 'updated' : 'installed';
  } catch { return 'failed'; }
}

function uninstallSlashCommand() {
  const p = slashCommandPath();
  if (!ours(p)) return false;
  try { fs.unlinkSync(p); return true; } catch { return false; }
}

function readSettings(p) {
  if (!fs.existsSync(p)) return {};
  const raw = fs.readFileSync(p, 'utf8');
  if (!raw.trim()) return {};
  return JSON.parse(raw); // throws on invalid JSON: we never overwrite a file we can't parse
}

function install({ refresh = 30 } = {}) {
  if (/[\\/]_npx[\\/]/.test(__dirname)) {
    return { ok: false, msg: 'pacr is running from a temporary npx folder, which can disappear.\nInstall it first:  npm install -g pacr   then run:  pacr install' };
  }
  const p = claudeSettingsPath();
  let s;
  try { s = readSettings(p); } catch (e) {
    return { ok: false, msg: `Couldn't parse ${p} (${e.message}). Fix it or add the status line manually:\n  "statusLine": { "type": "command", "command": ${JSON.stringify(command())}, "refreshInterval": ${refresh} }` };
  }
  const prev = s.statusLine;
  if (prev && !(prev.command || '').includes('pacr.js')) {
    writeJSON(file('statusline-backup.json'), { statusLine: prev, savedAt: Date.now() });
  }
  fs.mkdirSync(path.dirname(p), { recursive: true });
  if (fs.existsSync(p)) fs.copyFileSync(p, p + '.pacr.bak');
  s.statusLine = { type: 'command', command: command(), refreshInterval: refresh };
  fs.writeFileSync(p, JSON.stringify(s, null, 2) + '\n');
  // Index the last 8 days of logs now, so the first status line render is fast.
  try { require('./logs').updateRollup({ minIntervalMs: 0 }); } catch { /* ignore */ }
  const slash = installSlashCommand();
  const slashMsg = {
    installed: '\n/pacr command added: type /pacr (or /pacr week, /pacr tips …) inside Claude Code.',
    updated: '\n/pacr command updated.',
    kept: `\nYou already have your own /pacr command, so it was left as is (${slashCommandPath()}).`,
    failed: `\nCouldn't add the /pacr command (${slashCommandPath()}).`
  }[slash];
  return {
    ok: true,
    msg: `Status line installed in ${p}` + (prev && !(prev.command || '').includes('pacr.js') ? '\nYour previous status line was saved; `pacr uninstall` restores it.' : '') + slashMsg +
      '\nRestart Claude Code (or start a new session) to see it.'
  };
}

function uninstall() {
  const p = claudeSettingsPath();
  let s;
  try { s = readSettings(p); } catch (e) { return { ok: false, msg: `Couldn't parse ${p}: ${e.message}` }; }
  const backup = readJSON(file('statusline-backup.json'), null);
  if (backup && backup.statusLine) s.statusLine = backup.statusLine;
  else delete s.statusLine;
  fs.writeFileSync(p, JSON.stringify(s, null, 2) + '\n');
  const slash = uninstallSlashCommand();
  return { ok: true, msg: (backup ? 'Restored your previous status line.' : 'Removed the pacr status line.') + (slash ? '\nRemoved the /pacr command.' : '') };
}

function status() {
  const p = claudeSettingsPath();
  try {
    const s = readSettings(p);
    return { path: p, installed: !!(s.statusLine && String(s.statusLine.command || '').includes('pacr.js')), statusLine: s.statusLine || null, slash: { path: slashCommandPath(), exists: fs.existsSync(slashCommandPath()), ours: ours(slashCommandPath()) } };
  } catch (e) {
    return { path: p, installed: false, error: e.message };
  }
}

module.exports = { install, uninstall, status, command, slashCommandPath, SLASH_MARKER };
