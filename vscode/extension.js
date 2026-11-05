'use strict';
// pacr for VS Code: status bar usage, report panel and alerts.
// Uses the same local data as the pacr CLI (~/.claude/projects and ~/.pacr).
const vscode = require('vscode');
const tp = require('./src');

let item;
let timer;
let panel;

function cfg() { return vscode.workspace.getConfiguration('pacr'); }
const { fmtTok, fmtDur, fmtHM, fmtPct } = tp.util;

function statusText(st) {
  const parts = [`$(pulse) ${fmtTok(st.tokens.hour)}/h`, `${fmtTok(st.tokens.today)} today`];
  if (cfg().get('showWeekTokens')) parts.push(`${fmtTok(st.tokens.week)} wk`);
  const s = st.snap;
  if (cfg().get('showLimits') && s) {
    if (s.f != null) parts.push(`5h ${fmtPct(s.f)}`);
    if (s.w != null) parts.push(`wk ${fmtPct(s.w)}`);
  }
  if (st.burn && st.burn.willHit && s && s.f >= 50) parts.push(`$(warning) ~${fmtDur(st.burn.minsToFull * 60000)}`);
  return parts.join(' · ');
}

function tooltip(st) {
  const md = new vscode.MarkdownString(undefined, true);
  md.isTrusted = true;
  const s = st.snap;
  const now = Date.now();
  md.appendMarkdown('**pacr** · Claude Code usage\n\n');
  const k = st.tokens.cached; // cache reads kept out of the totals (null when included)
  const row = (label, n, kn) => `| ${label} | ${fmtTok(n)} |${k ? ` ${fmtTok(kn)} |` : ''}\n`;
  md.appendMarkdown((k ? '| | tokens | + cached |\n|---|---:|---:|\n' : '| | tokens |\n|---|---:|\n') +
    row('last hour', st.tokens.hour, k && k.hour) + row('today', st.tokens.today, k && k.today) +
    row(st.tokens.weekIsLimitWindow ? 'this limit week' : 'last 7 days', st.tokens.week, k && k.week));
  if (st.budget.daily) md.appendMarkdown(`| daily budget | ${Math.round(st.budget.daily.pct)}% of ${fmtTok(st.budget.daily.limit)} |\n`);
  md.appendMarkdown('\n');
  if (s && (s.f != null || s.w != null)) {
    if (s.f != null) md.appendMarkdown(`**5-hour:** ${fmtPct(s.f)} · resets ${fmtHM(s.fr)} (in ${fmtDur(s.fr - now)})  \n`);
    if (s.w != null) md.appendMarkdown(`**Weekly:** ${fmtPct(s.w)} · resets in ${fmtDur(s.wr - now)}  \n`);
    if (st.burn && st.burn.willHit) md.appendMarkdown(`$(warning) At this pace you hit the 5-hour limit in ~${fmtDur(st.burn.minsToFull * 60000)}  \n`);
    if (st.tip && (s.f >= st.cfg.warnPct || (st.burn && st.burn.willHit))) md.appendMarkdown(`$(lightbulb) ${st.tip}  \n`);
    if (st.snapAgeMs != null) md.appendMarkdown(`\n_limits from last Claude Code reply, ${fmtDur(st.snapAgeMs)} ago_\n`);
  } else {
    md.appendMarkdown('_No limit data yet. Run `pacr install` in a terminal so Claude Code shares its 5-hour and weekly limits._\n');
  }
  md.appendMarkdown('\n[Open report](command:pacr.showReport)');
  return md;
}

function refresh() {
  let st;
  try {
    st = tp.state.getState({ minScanIntervalMs: 5000 });
  } catch (e) {
    item.text = '$(pulse) pacr: error';
    item.tooltip = String(e && e.message);
    return;
  }
  item.text = statusText(st);
  item.tooltip = tooltip(st);
  const s = st.snap;
  const worst = Math.max(s && s.f != null ? s.f : 0, s && s.w != null ? s.w : 0, st.budget.daily ? st.budget.daily.pct * 0.9 : 0);
  item.backgroundColor = worst >= st.cfg.dangerPct
    ? new vscode.ThemeColor('statusBarItem.errorBackground')
    : worst >= st.cfg.warnPct ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;

  // Time-based alerts (reset ready, budgets, weekly summary) also run here,
  // so they work when Claude Code isn't open in a terminal.
  try { tp.alerts.evaluate(st, { inlineSummary: true, desktop: cfg().get('desktopNotifications') }); } catch { /* ignore */ }
  showNewAlerts();
}

let ctxRef;
function showNewAlerts() {
  if (!cfg().get('notifications')) return;
  const last = ctxRef.globalState.get('pacr.lastAlert', Date.now());
  const fresh = tp.alerts.recent(20).filter((a) => a.t > last).sort((a, b) => a.t - b.t);
  if (!fresh.length) { if (!ctxRef.globalState.get('pacr.lastAlert')) ctxRef.globalState.update('pacr.lastAlert', Date.now()); return; }
  ctxRef.globalState.update('pacr.lastAlert', fresh[fresh.length - 1].t);
  for (const a of fresh.slice(-3)) {
    const text = `pacr: ${a.title}. ${a.msg}`;
    const show = a.level === 'info' ? vscode.window.showInformationMessage : vscode.window.showWarningMessage;
    show(text, 'Open report').then((pick) => { if (pick) showReport(); });
  }
}

// ---------------- report panel ----------------
const SECTIONS = [
  ['overview', 'Now'], ['today', 'Today'], ['week', 'Week'], ['month', 'Month'], ['sessions', 'Sessions'], ['branches', 'Branches'],
  ['heatmap', 'Heatmap'], ['tips', 'Tips'], ['tools', 'Tools'], ['plan', 'Plan'], ['summary', 'Last week'], ['alerts', 'Alerts']
];

function renderSection(name) {
  tp.util.setColorMode('html');
  try {
    const r = tp.reports;
    switch (name) {
      case 'today': return r.today();
      case 'week': return r.week();
      case 'month': return r.month();
      case 'sessions': return r.sessions({ top: 15 });
      case 'branches': return r.branches();
      case 'heatmap': return r.heatmap();
      case 'tips': return r.tips();
      case 'tools': return r.tools();
      case 'plan': return r.plan();
      case 'summary': return r.summary();
      case 'alerts': return r.alertsView();
      default: return r.overview();
    }
  } catch (e) {
    return tp.util.esc('Error: ' + (e && e.stack ? e.stack : e));
  } finally {
    tp.util.setColorMode('ansi');
  }
}

function html(webview) {
  const nonce = Math.random().toString(36).slice(2);
  const tabs = SECTIONS.map(([k, label]) => `<button data-k="${k}">${label}</button>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);padding:12px 16px}
nav{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px}
button{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);border:0;border-radius:4px;padding:4px 10px;cursor:pointer;font-size:12px}
button.on{background:var(--vscode-button-background);color:var(--vscode-button-foreground)}
pre{font-family:var(--vscode-editor-font-family);font-size:var(--vscode-editor-font-size);line-height:1.5;white-space:pre;overflow-x:auto;margin:0}
.g{color:var(--vscode-terminal-ansiGreen)}.y{color:var(--vscode-terminal-ansiYellow)}.r{color:var(--vscode-terminal-ansiRed)}
.d{color:var(--vscode-descriptionForeground)}.b{color:var(--vscode-terminal-ansiBlue)}.c{color:var(--vscode-terminal-ansiCyan)}
.m{color:var(--vscode-terminal-ansiMagenta)}.w{color:var(--vscode-foreground);font-weight:600}
.muted{color:var(--vscode-descriptionForeground);font-size:12px;margin-top:14px}
</style></head><body>
<nav>${tabs}</nav><pre id="out">Loading…</pre>
<p class="muted">Local data only · ~/.claude/projects and ~/.pacr</p>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const st = vscode.getState() || { k: 'overview' };
let cur = st.k;
function sel(k){ cur = k; document.querySelectorAll('button').forEach(b=>b.classList.toggle('on', b.dataset.k===k)); document.getElementById('out').textContent='Loading…'; vscode.setState({k}); vscode.postMessage({k}); }
document.querySelectorAll('button').forEach(b=>b.addEventListener('click',()=>sel(b.dataset.k)));
window.addEventListener('message', e => { if (e.data && e.data.html != null && (e.data.k == null || e.data.k === cur)) document.getElementById('out').innerHTML = e.data.html; });
sel(st.k);
</script></body></html>`;
}

function showReport() {
  if (panel) { panel.reveal(); return; }
  panel = vscode.window.createWebviewPanel('pacr', 'pacr', vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: false });
  panel.webview.html = html(panel.webview);
  panel.webview.onDidReceiveMessage((m) => {
    if (!m || !m.k) return;
    setTimeout(() => { if (panel) panel.webview.postMessage({ k: m.k, html: renderSection(m.k) }); }, 10);
  });
  panel.onDidDispose(() => { panel = undefined; });
}

function start() {
  if (timer) clearInterval(timer);
  const secs = Math.max(10, cfg().get('refreshSeconds') || 30);
  timer = setInterval(refresh, secs * 1000);
}

function activate(context) {
  ctxRef = context;
  const align = cfg().get('alignment') === 'left' ? vscode.StatusBarAlignment.Left : vscode.StatusBarAlignment.Right;
  item = vscode.window.createStatusBarItem('pacr.status', align, 100);
  item.name = 'pacr';
  item.command = 'pacr.showReport';
  item.text = '$(pulse) pacr';
  item.show();
  context.subscriptions.push(
    item,
    vscode.commands.registerCommand('pacr.showReport', showReport),
    vscode.commands.registerCommand('pacr.refresh', () => { refresh(); vscode.window.setStatusBarMessage('pacr refreshed', 2000); }),
    vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration('pacr')) { start(); refresh(); } }),
    { dispose: () => timer && clearInterval(timer) }
  );
  setTimeout(refresh, 500);
  start();
}

function deactivate() { if (timer) clearInterval(timer); }

module.exports = { activate, deactivate };
