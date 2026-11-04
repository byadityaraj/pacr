'use strict';
// Cross-platform desktop notifications with no dependencies. Never blocks, never throws.
const { spawn } = require('child_process');
const fs = require('fs');

function isWSL() {
  if (process.platform !== 'linux') return false;
  try { return /microsoft/i.test(fs.readFileSync('/proc/version', 'utf8')); } catch { return false; }
}

function run(cmd, args) {
  try {
    const p = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
    p.on('error', () => {});
    p.unref();
    return true;
  } catch {
    return false;
  }
}

function psToast(title, msg) {
  const q = (s) => String(s).replace(/'/g, "''").replace(/[<>&]/g, ' ');
  const script = [
    "$ErrorActionPreference='SilentlyContinue'",
    '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null',
    '$t = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)',
    '$n = $t.GetElementsByTagName("text")',
    `$n.Item(0).AppendChild($t.CreateTextNode('${q(title)}')) > $null`,
    `$n.Item(1).AppendChild($t.CreateTextNode('${q(msg)}')) > $null`,
    '$toast = [Windows.UI.Notifications.ToastNotification]::new($t)',
    "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe').Show($toast)"
  ].join('; ');
  return script;
}

function send(title, msg) {
  if (process.env.PACR_NO_NOTIFY) return false;
  title = String(title).slice(0, 120);
  msg = String(msg).slice(0, 240);
  if (process.platform === 'darwin') {
    const q = (s) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return run('osascript', ['-e', `display notification "${q(msg)}" with title "${q(title)}"`]);
  }
  if (process.platform === 'win32') {
    return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', psToast(title, msg)]);
  }
  if (isWSL()) {
    return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psToast(title, msg)]);
  }
  return run('notify-send', ['-a', 'pacr', title, msg]);
}

module.exports = { send, isWSL };
