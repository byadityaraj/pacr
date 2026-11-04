# pacr

Unofficial, local-only Claude Code usage tracker: tokens per hour/day/week/session, 5-hour and weekly limit %, burn rate, smart tips, alerts. Terminal status line + `/pacr` slash command + CLI reports + VS Code extension (also Cursor, Windsurf, VSCodium). Node 18+, **zero dependencies** — keep it that way.

## Layout
- `bin/pacr.js` — CLI entry and argument parsing. `pacr statusline` is the hot path.
- `src/logs.js` — reads `~/.claude/projects/**/*.jsonl`. `scan()` = full scan for reports. `updateRollup()` = incremental 5-min buckets in `~/.pacr/rollup.json` (reads only new bytes). Dedupe by `message.id:requestId`, keep the larger usage. Rollup buckets are `[all, noCacheReads]`.
- Token totals are **fresh tokens** (input + output + cache writes) by default; cache reads are shown separately as `+X cached` (reports, VS Code tooltip, `state.tokens.cached`), never in the status line. `countCacheReads: true` = old all-in totals (matches ccusage).
- `src/snapshots.js` — limit % from status line stdin (`rate_limits.five_hour/seven_day.used_percentage`, `resets_at` in epoch seconds). Logged ~1/min to `~/.pacr/snapshots.jsonl`; Claude Code keeps no history of these.
- `src/state.js` — current state (tokens, limits, burn rate, quick tip). Shared by status line, alerts, VS Code.
- `src/statusline.js` — 2–3 line output. Line 3 only when needed.
- `src/alerts.js` — fire-once alerts → `~/.pacr/alerts.jsonl` + desktop notification (`src/notify.js`).
- `src/analyze.js` — session stats, tips engine, plan fit. `src/reports.js` — all text reports (ansi or html via `util.setColorMode`).
- `src/install.js` — edits `statusLine` in `~/.claude/settings.json`, backs up the old one; writes `~/.claude/commands/pacr.md` (`/pacr`), marked with `<!-- installed by pacr -->` so a user's own file is never touched.
- `vscode/extension.js` — status bar, report webview, alert popups. `scripts/build-vscode.js` copies `src/` and `bin/` into `vscode/` and packages a .vsix.

## Rules
- Status line must stay fast (~140 ms warm on the maintainer's Mac, ~80 ms of that is Node start-up) and never exit non-zero or print to stderr; Claude Code cancels slow runs.
- Never read credentials or make network calls. Read Claude Code files only; write only to `~/.pacr` (and settings.json + commands/pacr.md on install).
- Limits are percentages from Claude Code; don't invent token caps per plan.
- Cross-platform: Windows status line command is `node "<forward-slash path>" statusline`; notifications use osascript / notify-send / PowerShell toast (also from WSL).
- In VS Code, `process.execPath` is Electron: child node processes need `ELECTRON_RUN_AS_NODE=1`.

## Test
- `npm test` — generates fake logs + snapshots in a temp HOME and checks every command (30 tests). CI runs it on macOS/Linux/Windows × Node 18/20/22 (`.github/workflows/test.yml`).
- `HOME=<tmp> PACR_HOME=<tmp>/.pacr node test/vscode-mock.js` — runs the extension against a mock `vscode`.
- `node scripts/build-vscode.js --package` → `dist/pacr-x.y.z.vsix`.
- Tested by hand on macOS (CLI, status line, /pacr; extension installed in VS Code + Cursor). Not yet on real Windows/Linux — CI is the first check there.
