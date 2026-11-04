'use strict';
// Loads the VS Code extension against a fake `vscode` module and exercises it.
const Module = require('module');
const path = require('path');
const assert = require('assert');

const messages = [];
const posted = [];
let statusItem;
let panelMsgHandler;
const cfgValues = { refreshSeconds: 30, alignment: 'right', showLimits: true, showWeekTokens: true, notifications: true, desktopNotifications: false };

const vscode = {
  StatusBarAlignment: { Left: 1, Right: 2 },
  ViewColumn: { Active: -1 },
  ThemeColor: class { constructor(id) { this.id = id; } },
  MarkdownString: class { constructor() { this.value = ''; } appendMarkdown(s) { this.value += s; return this; } },
  window: {
    createStatusBarItem: () => (statusItem = { show() {}, dispose() {} }),
    showInformationMessage: (m) => { messages.push(['info', m]); return Promise.resolve(); },
    showWarningMessage: (m) => { messages.push(['warn', m]); return Promise.resolve(); },
    showErrorMessage: (m) => { messages.push(['error', m]); return Promise.resolve(); },
    setStatusBarMessage: () => {},
    createWebviewPanel: () => ({
      reveal() {}, onDidDispose() {},
      webview: { html: '', onDidReceiveMessage: (h) => { panelMsgHandler = h; }, postMessage: (m) => { posted.push(m); } }
    })
  },
  commands: { _c: {}, registerCommand(id, fn) { this._c[id] = fn; return { dispose() {} }; } },
  workspace: { getConfiguration: () => ({ get: (k) => cfgValues[k] }), onDidChangeConfiguration: () => ({ dispose() {} }) }
};

const origLoad = Module._load;
Module._load = function (req, ...rest) { return req === 'vscode' ? vscode : origLoad.call(this, req, ...rest); };

const state = new Map();
const context = { subscriptions: [], globalState: { get: (k, d) => (state.has(k) ? state.get(k) : d), update: (k, v) => { state.set(k, v); return Promise.resolve(); } } };

const ext = require(path.join(__dirname, '..', 'vscode', 'extension.js'));
ext.activate(context);

setTimeout(() => {
  try {
    console.log('status bar:', statusItem.text);
    assert.match(statusItem.text, /^\$\(pulse\) \S+\/h · \S+ today · \S+ wk/);
    assert.ok(statusItem.tooltip.value.includes('pacr'));
    assert.match(statusItem.tooltip.value, /\| \| tokens \| \+ cached \|/, 'tooltip shows cache reads separately');
    console.log('tooltip:', statusItem.tooltip.value.split('\n').filter((l) => l.startsWith('|')).join('  '));
    console.log('background:', statusItem.backgroundColor && statusItem.backgroundColor.id);

    vscode.commands._c['pacr.showReport']();
    for (const k of ['overview', 'today', 'week', 'sessions', 'branches', 'heatmap', 'tips', 'plan', 'summary', 'alerts']) panelMsgHandler({ k });
    setTimeout(() => {
      assert.strictEqual(posted.length, 10);
      for (const p of posted) {
        assert.ok(p.html.length > 30);
        assert.doesNotMatch(p.html, /\x1b\[|NaN|undefined|Error:/);
      }
      console.log('report panel: 10 sections rendered as html, e.g.\n' + posted[2].html.split('\n').slice(0, 3).join('\n'));
      console.log('vscode notifications so far:', messages.length);
      ext.deactivate();
      console.log('VS CODE MOCK OK');
      process.exit(0);
    }, 1500);
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
}, 1200);
