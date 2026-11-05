# Changelog

## 0.2.0 — 2026-11-05

### New
- `pacr month [--last]`: calendar month by week, a day strip, top projects and branches, and a comparison with last month over the same days.
- `pacr day YYYY-MM-DD` and `pacr yesterday`: the hour-by-hour report for any day.
- `pacr tools [--days 7]`: the biggest tool results (Bash commands, files read), with a suggestion for each one: filter test/build output, block noisy files with `permissions.deny`, or grep/read a range of a large file. Also a **Tools** tab in VS Code.
- `pacr hooks install | status | off | on | uninstall`: an opt-in PreToolUse hook that trims the output of simple test/build commands (npm/pnpm/yarn test and build, pytest, go test, cargo test) to failures, errors and the summary, at most ~150 lines. Exit codes are kept. Every other command, and any error, passes through unchanged. Your permission rules are checked against the original command: a deny or ask rule means it isn't rewritten, an allow rule keeps it allowed. Shows what it adds to settings.json and asks first. `pacr uninstall` removes it too, and `pacr doctor` reports it.
- [docs/limits.md](docs/limits.md): estimates of how many tokens fit in the 5-hour and weekly limits, per model.

### Fixed
- Limit % across several sessions: an idle session no longer overwrites the numbers with its stale ones (5h going 2% → 1% → 2%). Within one window the highest % any session reported is kept, and a new window replaces it. Applies to the status line, `pacr`, alerts and VS Code.
- "limits as of 0m ago" was the time the status line ran. It's now "limits from last Claude Code reply, Xm ago".
- Percentages under 10% show one decimal when there is one.
- Editor report tab fix, shorter week total line, clearer VS Code install steps.

## 0.1.0 — 2026-11-04

First release.

- Status line in Claude Code: tokens this hour, today and this week, plus the 5-hour and weekly limits with reset countdowns. A third line only when it matters: burn rate, close to a limit, or over budget, with the one action that saves the most (`/compact`, `/model sonnet`, `/clear`).
- Totals count fresh tokens (input + output + cache writes). Cache reads are shown separately (`countCacheReads: true` brings back all-in totals).
- `/pacr` slash command inside Claude Code.
- Reports: `today`, `week`, `sessions`, `session <id>`, `branches`, `heatmap`, `tips`, `plan`, `summary`, `export`.
- Alerts as desktop notifications: limit thresholds, burn rate, budgets, window reset, weekly summary.
- VS Code, Cursor, Windsurf and VSCodium extension: status bar, report panel, alerts.
- Local only: reads Claude Code's logs, writes only to `~/.pacr`. No network, no credentials. Zero dependencies.
