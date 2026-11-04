'use strict';
const os = require('os');
const path = require('path');
const fs = require('fs');

const HOME = os.homedir();

// Where Claude Code keeps its config and session logs.
function claudeDirs() {
  const dirs = [];
  const env = process.env.CLAUDE_CONFIG_DIR;
  if (env) {
    for (const d of env.split(',')) if (d.trim()) dirs.push(path.resolve(d.trim()));
  }
  dirs.push(path.join(HOME, '.claude'));
  dirs.push(path.join(process.env.XDG_CONFIG_HOME || path.join(HOME, '.config'), 'claude'));
  return [...new Set(dirs)].filter((d) => {
    try { return fs.statSync(d).isDirectory(); } catch { return false; }
  });
}

function projectDirs() {
  return claudeDirs()
    .map((d) => path.join(d, 'projects'))
    .filter((d) => { try { return fs.statSync(d).isDirectory(); } catch { return false; } });
}

// pacr's own data folder.
function dataDir() {
  const d = process.env.PACR_HOME || path.join(HOME, '.pacr');
  try { fs.mkdirSync(d, { recursive: true }); } catch { /* ignore */ }
  return d;
}

const file = (name) => path.join(dataDir(), name);

function claudeSettingsPath() {
  const env = process.env.CLAUDE_CONFIG_DIR;
  const base = env ? path.resolve(env.split(',')[0].trim()) : path.join(HOME, '.claude');
  return path.join(base, 'settings.json');
}

module.exports = { HOME, claudeDirs, projectDirs, dataDir, file, claudeSettingsPath };
