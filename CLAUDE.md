# pacr

Unofficial, local-only Claude Code usage tracker: tokens per hour/day/week/session, 5-hour and weekly limit %, burn rate, smart tips, alerts. Terminal status line + `/pacr` slash command + CLI reports + VS Code extension (also Cursor, Windsurf, VSCodium). Node 18+, **zero dependencies** — keep it that way.

## Layout
- `bin/pacr.js` — CLI entry and argument parsing. `pacr statusline` is the hot path.
- `src/logs.js` — reads `~/.claude/projects/**/*.jsonl`. `scan()` = full scan for reports. `updateRollup()` = incremental 5-min buckets in `~/.pacr/rollup.json` (reads only new bytes). Dedupe by `message.id:requestId`, keep the larger usage. Rollup buckets are `[all, noCacheReads]`.
- Token totals are **fresh tokens** (input + output + cache writes) by default; cache reads are shown separately as `+X cached` (reports, VS Code tooltip, `state.tokens.cached`), never in the status line. `countCacheReads: true` = old all-in totals (matches ccusage).
- `src/snapshots.js` — limit % from status line stdin (`rate_limits.five_hour/seven_day.used_percentage`, `resets_at` in epoch seconds). Logged ~1/min to `~/.pacr/snapshots.jsonl`; Claude Code keeps no history of these.
- `src/estimate.js` — Claude Code's limit % is a whole number with the decimal dropped. On each step up (n → n+1) within a window it records the moment + window fresh tokens in `~/.pacr/estimate.json`; tokens between two steps = tokens per 1% (else the average of earlier windows; none = no estimate). Estimate = n + tokens since step ÷ per 1%, clamped to [n, n+0.99], shown rounded with `~` when it differs. Status line/VS Code use it; alerts and `st.snap` keep the raw number. First status line run spawns `pacr estimate --backfill` once (replays 8 days of snapshots via the same `observe()`, marks `backfilled` in estimate.json); tests set `PACR_NO_BACKFILL=1`.
- `src/state.js` — current state (tokens, limits, burn rate, quick tip). Shared by status line, alerts, VS Code.
- `src/statusline.js` — 2–3 line output. Line 3 only when needed.
- `src/alerts.js` — fire-once alerts → `~/.pacr/alerts.jsonl` + desktop notification (`src/notify.js`).
- `src/analyze.js` — session stats, tips engine, plan fit. `src/reports.js` — all text reports (ansi or html via `util.setColorMode`). `monthData()` is pure (records + snapshots in, numbers out) so month logic is unit-tested without logs.
- Claude Code deletes logs older than `cleanupPeriodDays` (default 30): anything comparing against older data must say it may be incomplete.
- `src/install.js` — edits `statusLine` in `~/.claude/settings.json`, backs up the old one; writes `~/.claude/commands/pacr.md` (`/pacr`), marked with `<!-- installed by pacr -->` so a user's own file is never touched.
- `src/tools.js` — `pacr tools`: tool result sizes (chars/4) from `tool_use`/`tool_result` blocks, grouped by tool + target (Bash by normalized command, Read by file), with suggestions.
- `src/hooks.js` — opt-in PreToolUse hook (`pacr hooks install`). `pacr hook` rewrites only simple test/build commands to `(set -o pipefail; cmd 2>&1 | pacr filter "cmd")`, returns `updatedInput`, plus `permissionDecision: "allow"` only when a permissions.allow rule covers the ORIGINAL command; a deny/ask rule on the original (or an unreadable settings file) means no rewrite. Prints `{}` on anything else or any error. Live-tested on macOS (Claude Code 2.1.287: debug log shows `modified tool input keys: [command, description]`); not yet on Windows/Linux. `pacr filter` keeps failures/errors/summary, ≤ ~150 lines. `pacr hooks off` = `hooks.enabled: false` in config, no settings edit. `bin/pacr.js` dispatches `hook`/`filter` before loading reports.
- `vscode/extension.js` — status bar, report webview, alert popups. `scripts/build-vscode.js` copies `src/` and `bin/` into `vscode/` and packages a .vsix.

## Rules
- Status line must stay fast (~140 ms warm on the maintainer's Mac, ~80 ms of that is Node start-up) and never exit non-zero or print to stderr; Claude Code cancels slow runs.
- Never read credentials or make network calls. Read Claude Code files only; write only to `~/.pacr` (and settings.json + commands/pacr.md on install, settings.json hooks on `pacr hooks install`).
- Limits are percentages from Claude Code; don't invent token caps per plan.
- Cross-platform: Windows status line command is `node "<forward-slash path>" statusline`; notifications use osascript / notify-send / PowerShell toast (also from WSL).
- In VS Code, `process.execPath` is Electron: child node processes need `ELECTRON_RUN_AS_NODE=1`.

## Test
- `npm test` — generates fake logs + snapshots in a temp HOME and checks every command (52 tests). CI runs it on macOS/Linux/Windows × Node 18/20/22 (`.github/workflows/test.yml`).
- `HOME=<tmp> PACR_HOME=<tmp>/.pacr node test/vscode-mock.js` — runs the extension against a mock `vscode`.
- `node scripts/build-vscode.js --package` → `dist/pacr-x.y.z.vsix`.
- Tested by hand on macOS (CLI, status line, /pacr; extension installed in VS Code + Cursor). Not yet on real Windows/Linux — CI is the first check there.

## Git
- Never add Co-Authored-By, Claude-Session or 'Generated with Claude Code' lines to commits, PRs or releases.
