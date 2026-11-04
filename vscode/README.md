# pacr for VS Code

Also works in Cursor, Windsurf, VSCodium and other VS Code-based editors.

Unofficial, local-only Claude Code usage tracker. Shows how many tokens you're using and how close you are to your limits, right in the status bar.

```
$(pulse) 312k/h · 2.4M today · 5h 78% · wk 41%
```

- **Status bar**: tokens in the last hour and today, plus your 5-hour and weekly limit %. Turns yellow at 70% and red at 90%.
- **Hover** for details: reset times, burn-rate warning, and the one action that saves the most right now (`/compact`, `/model sonnet` or `/clear`).
- **Click** to open the report: today by hour, week, top sessions, tokens per git branch, heatmap, tips, plan fit, weekly summary and alerts.
- **Alerts** as VS Code notifications: limit thresholds, burn rate, your own budgets, "window reset — you're good to go", weekly summary.

Works whether you use Claude Code in the integrated terminal or in the Claude Code extension panel: both write the same local logs.

## Limit percentages

Token counts work on their own. The 5-hour and weekly **percentages** come from Claude Code's status line, so install the CLI once and add it:

```
npm install -g github:byadityaraj/pacr
pacr install
```

Source, CLI docs and issues: https://github.com/byadityaraj/pacr

## Privacy

Reads `~/.claude/projects/*.jsonl` and writes only to `~/.pacr`. No network calls, never reads your login token.

Not affiliated with Anthropic.
