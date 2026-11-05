# How many tokens do you get?

Anthropic shows your Claude Code limits as percentages, not token counts. This page estimates how many tokens fit in 1% and 100% of the 5-hour and weekly limits.

## Measured

On Team (Premium seat), with Opus 5.5 at medium effort, 255k fresh tokens (input + output + cache writes) used 3% of the 5-hour window and 1% of the week (measured Nov 5, 2026).

In an earlier week, 24.8M fresh tokens used 83% of the week, so a full week is about 30M. This is the more reliable figure (see below).

## Estimates

| Model | Price vs Opus 5.5 | 1% of week ≈ | 100% of 5h ≈ | 100% of week ≈ | Source |
|---|---|---|---|---|---|
| Fable 5.1 / Mythos 5.1 | 2.5× | ~110k | ~3.4M | ~10–12M | estimated |
| Opus 5.5 | 1× | ~270k | ~8.5M | ~25–30M | measured |
| Opus 5.5 fast mode | 2× | ~135k | ~4.2M | ~13–15M | estimated |
| Sonnet 5.5 | 0.5× | ~550k | ~17M | ~50–60M | estimated |
| Haiku 5.5 (context over 100k, usual in Claude Code) | 0.125× | ~2.2M | ~68M | ~200–240M | estimated |
| Haiku 5.5 (prompts under 100k) | 0.025× | ~11M | ~340M | ~1B+ | estimated |

## How we estimated

Only Opus 5.5 was measured. The other models are scaled from that measurement by their official [API price](https://platform.claude.com/docs/en/about-claude/pricing). This assumes limits are weighted by API cost, which Anthropic doesn't confirm.

## Read this before using the numbers

- The numbers are for one plan. Pro, Max 5×, Max 20× and Team seats differ a lot.
- Effort doesn't change tokens per 1%, only how many tokens a task uses.
- Cache reads aren't in the fresh count but still use the limit, so long sessions use it faster than the fresh number suggests.
- Claude Code passes whole-number percentages. Readings so far suggest it drops the decimal (2.7% → 2%), while claude.ai/settings/usage rounds (→ 3%), so its raw number can be 1% less than the usage page. If it truncates, "1%" likely means 1–1.99%, so 255k at 1% means roughly 13M–26M per week. The 24.8M at 83% reading is the more reliable one: it barely moves either way (about 29.5–30M). Bigger percentages give better estimates.
- Limits can change at any time. This is not official and not affiliated with Anthropic.

## pacr's decimal estimate

When Claude Code's whole number goes up (2 → 3), the real value was about 3.0% at that moment, so the fresh tokens between two such steps tell pacr how many tokens make 1%, and the tokens since the last step give the decimal (rounded like claude.ai, shown as `~3%` when it differs). It's kept between n and n + 0.99, so it's never more than 1% off; alerts still use Claude Code's own number, and `pacr doctor` / `pacr json` show both. On first run pacr learns from the snapshots and logs of the last 8 days (`pacr estimate --backfill` shows what it found); tokens per 1% can vary several-fold between windows, which the clamp absorbs.

## Measure your own

Run `pacr week` and divide the week's tokens by your weekly %. Readings at 30% or more give the best estimate.

Share your numbers in a [GitHub issue](https://github.com/byadityaraj/pacr/issues/new?template=limit-data.yml) with your plan, model, effort, tokens and %, and we'll add them here.
