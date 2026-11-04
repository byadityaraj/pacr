# pacr

**See how many tokens you're burning in Claude Code — per hour, day, week and session — and how close you are to your 5-hour and weekly limits.**

Status line in Claude Code · `/pacr` command · CLI reports · status bar in VS Code, Cursor and other VS Code-based editors. Unofficial, local-only, zero dependencies.

```
hour 312k · today 2.4M · week 6.6M
5h ████████░░ 78% resets 1h42m  │  week ████░░░░░░ 41% resets 3d6h
⚠ burn rate high — at this pace you hit the 5h limit in ~38m
```

The third line only shows up when it matters. Close to a limit, it turns red and tells you the one thing that saves the most right now:

| situation | tip |
|---|---|
| context over 50% | `try /compact (ctx 72%)` |
| small context, on Opus | `try /model sonnet for routine steps` |
| otherwise | `starting something new? /clear first` |

## Install

Needs Node.js 18+. Works on macOS, Linux, Windows and WSL.

```bash
npm install -g pacr       # or straight from GitHub: npm install -g github:byadityaraj/pacr
pacr install              # adds the status line and the /pacr command to Claude Code
pacr doctor               # checks everything is wired up
```

Start a new Claude Code session and the status line appears at the bottom.

`pacr install` changes `statusLine` in `~/.claude/settings.json` (backup in `settings.json.pacr.bak`; an existing status line is saved and restored by `pacr uninstall`) and adds `~/.claude/commands/pacr.md`. It never overwrites a `/pacr` command you wrote yourself.

## Use it inside Claude Code

| you type | what happens |
|---|---|
| `/pacr`, `/pacr week`, `/pacr tips` … | runs pacr and Claude points out the one thing that stands out |
| `! pacr today` | runs pacr directly — no model call, fewer tokens |

## VS Code, Cursor, Windsurf, VSCodium

The extension shows `312k/h · 2.4M today · 5h 78% · wk 41%` in the status bar, opens a full report on click, and shows alerts as notifications. It works whether you run Claude Code in the integrated terminal or in the Claude Code extension panel — both write the same local logs.

1. Download `pacr-x.y.z.vsix` from [Releases](https://github.com/byadityaraj/pacr/releases) (or build it: `node scripts/build-vscode.js --package`).
2. Install it:
   - **From the editor:** Extensions view → `⋯` menu → **Install from VSIX…**
   - **From a terminal:**
     ```bash
     code --install-extension pacr-0.1.0.vsix       # VS Code
     cursor --install-extension pacr-0.1.0.vsix     # Cursor
     windsurf --install-extension pacr-0.1.0.vsix   # Windsurf
     codium --install-extension pacr-0.1.0.vsix     # VSCodium
     ```
     No `code`/`cursor` command? On macOS: Command Palette → *Shell Command: Install 'code' command in PATH*.
3. Reload the window.

Token counts work on their own. The limit percentages come from Claude Code's status line, so also run `pacr install` once.

Settings (`pacr.*` in the editor settings): refresh interval, left/right alignment, show limits, show week tokens, notifications.

## Commands

| command | what you get |
|---|---|
| `pacr` | right now: tokens + limits |
| `pacr today [--date 2026-11-03]` | hour by hour: tokens, % of the 5h window each hour used, peak hour and the session behind it |
| `pacr week [--last]` | day by day, weekly limit projection, "keep under X tokens/day", vs last week |
| `pacr sessions [--top 10] [--days 7]` | heaviest sessions, flagged: heavy, long context, big context, cache rebuilds |
| `pacr session <id>` | one session: input/output/cache breakdown, 30-min timeline, how much later messages cost |
| `pacr branches [--days 30]` | tokens per git branch — what a feature actually cost |
| `pacr heatmap [--weeks 4]` | weekday × hour grid of when you burn the most |
| `pacr tips [--days 7]` | ranked ways to save tokens, from your own data |
| `pacr plan [--days 28]` | limit hits, time spent waiting for resets, whether your plan fits |
| `pacr summary [--this]` | a week in one screen (last week by default) |
| `pacr alerts` / `pacr alerts test` | alert settings and recent alerts / send a test notification |
| `pacr budget daily 3M` | your own token budget (`weekly` too; `off` to remove) |
| `pacr config [key] [value]` | view or change settings (below) |
| `pacr export --csv --days 30 --out usage.csv` | raw data for Excel / Sheets (`--json` too); every token column, `total` includes cache reads |
| `pacr watch` | keep alerts running while Claude Code is closed |
| `pacr doctor` | check the setup |
| `pacr uninstall` | remove the status line and `/pacr`, restore your previous status line |

Output is coloured in a terminal and plain when piped. `--no-color` / `NO_COLOR=1` turn colours off, `--color` forces them on.

## Settings

`pacr config` prints everything; `pacr config <key> <value>` changes one. Stored in `~/.pacr/config.json`.

| key | default | meaning |
|---|---|---|
| `warnPct` / `dangerPct` | `70` / `90` | status line turns yellow / red at this limit % |
| `countCacheReads` | `false` | `true` adds cache reads back into the totals (the old behaviour, matches ccusage) |
| `budget.daily` / `budget.weekly` | off | your own token budgets — easier with `pacr budget` |
| `notify.enabled` | `true` | desktop notifications on/off |
| `notify.fiveHour` | `90` | notify when the 5h window crosses these % (several: `80,95`) |
| `notify.weekly` | `80,90` | notify when the weekly window crosses these % |
| `notify.burnRate` / `notify.burnMinutes` | `true` / `45` | warn when you're on pace to hit the 5h limit within N minutes |
| `notify.resetReady` | `true` | tell you when a window you maxed out has reset |
| `notify.budget` | `true` | notify at 80% and 100% of your budget |
| `notify.sessionCostUsd` | `5` | nudge when one session passes this estimated cost (`null` = off) |
| `notify.weeklySummary` | `true` | last week's summary every Monday |

```bash
pacr config warnPct 60
pacr config notify.weekly 70,90
pacr config notify.enabled false
```

## Alerts

Each one fires once per window / day / session, as a desktop notification and in the editor.

- 5-hour limit at 90%, weekly at 80% and 90%
- burn rate: "you'll hit the 5h limit in under 45 min"
- **reset ready**: a window you maxed out has reset — good to go
- your own daily / weekly budget at 80% and 100%
- one session passes $5 (estimated) → nudge to `/clear` or `/compact`
- Monday: last week's summary

## How it works

- **Tokens** come from Claude Code's local session logs (`~/.claude/projects/**/*.jsonl`). Each API response is counted once (Claude Code sometimes logs one response on several lines).
- **Totals are fresh tokens: input + output + cache writes.** Cache reads are usually 90%+ of the raw number but count far less toward your limits, so including them makes the totals misleading ("week 1.78B"). Reports show them separately and dimmed — `total 92M · +1.69B cached` — and the status line leaves them out to stay short. This means pacr's totals **no longer match ccusage by default**; `pacr config countCacheReads true` brings back the all-in numbers. `pacr export` always has every column (input, output, cache write, cache read) and an all-in `total`.
- **Limit percentages** (5-hour and weekly) come from the data Claude Code passes to the status line. They exist only on Pro / Max plans. Anthropic publishes limits as percentages, not token counts, so pacr shows both: tokens for your usage, percentages for how close you are. It never guesses token caps per plan.
- Claude Code keeps no history of those percentages, so pacr saves a snapshot about once a minute while you work (`~/.pacr/snapshots.jsonl`). That powers burn rate, limit-hit history, `plan` and the "5h window" column. They get more accurate after a few days.
- The status line reads only the new bytes of each log and keeps 5-minute buckets in `~/.pacr/rollup.json`, so each refresh does a few tens of milliseconds of work on top of Node's start-up time.

## Privacy

- Reads Claude Code's logs and settings. Writes only to `~/.pacr`, plus `statusLine` in `~/.claude/settings.json` and `~/.claude/commands/pacr.md` when you run `pacr install`.
- **No network calls. Never reads your login token or credentials.**
- `PACR_HOME` changes the data folder. `CLAUDE_CONFIG_DIR` is respected.

## Troubleshooting

Run `pacr doctor` first.

| problem | fix |
|---|---|
| status line doesn't appear | start a new Claude Code session; check `pacr doctor` |
| no limit percentages | they appear after the first reply in a Pro/Max session; API-key logins have none |
| `EACCES` on `npm install -g` | your npm global folder is owned by root: `sudo chown -R $(id -u):$(id -g) "$(npm config get prefix)" ~/.npm` — don't use `sudo npm` |
| text hard to read on a light terminal | pacr uses your terminal's own colours; also pick a light theme in Claude Code with `/theme` |
| no desktop notifications | `pacr alerts test`; on Linux install `notify-send` (libnotify) |
| `/pacr` missing | run `pacr install` again, then start a new session |

## Develop

```bash
git clone https://github.com/byadityaraj/pacr && cd pacr
npm link                                  # puts your checkout on PATH as `pacr`
npm test                                  # generates fake logs and checks every command
node scripts/build-vscode.js --package    # builds dist/pacr-x.y.z.vsix
```

No dependencies — please keep it that way. The status line (`pacr statusline`) is the hot path: it must stay fast, never print to stderr and never exit non-zero. Issues and PRs are welcome.

## Not affiliated with Anthropic

pacr is an independent project. "Claude" and "Claude Code" are trademarks of Anthropic. Costs shown are Claude Code's own estimates at API list prices and may differ from your bill.

[MIT License](LICENSE)
