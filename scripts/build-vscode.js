'use strict';
// Copies the shared library into the extension folder and packages a .vsix.
// Usage: node scripts/build-vscode.js [--package]
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const root = path.join(__dirname, '..');
const ext = path.join(root, 'vscode');

for (const dir of ['src', 'bin']) {
  fs.rmSync(path.join(ext, dir), { recursive: true, force: true });
  fs.cpSync(path.join(root, dir), path.join(ext, dir), { recursive: true });
}
fs.copyFileSync(path.join(root, 'LICENSE'), path.join(ext, 'LICENSE'));
console.log('Copied src/ and bin/ into vscode/');

if (process.argv.includes('--package')) {
  fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
  execSync('npx --yes @vscode/vsce package --no-dependencies --out ../dist/', { cwd: ext, stdio: 'inherit' });
}
