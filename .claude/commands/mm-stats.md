---
description: Compare DeepSeek/GLM/etc keep-vs-drop rates and effective cost-per-kept-output across every /mm-* command and moo/rr pipeline stage
argument-hint: [--by-command] [--reasons] [--since 30d] [--all-repos path1,path2] [--json]
allowed-tools: Bash(node scripts/multi-model/outcome-stats.js:*)
model: haiku
---

# Multi-Model Outcome Stats

## Process

1. Parse `$ARGUMENTS` and pass any of `--by-command`, `--reasons`, `--since <duration>`, `--all-repos <path1,path2>`, `--json` straight through.
2. Run:
   ```bash
   node scripts/multi-model/outcome-stats.js [flags]
   ```
3. Present the table to the user as-is. Call out anything actionable - e.g. a provider whose `Eff.$/kept` is far worse than its sticker price, or (with `--by-command`) a command where one provider's keep rate is much lower than its average across all commands.

## Rules

- `Offline` counts calls that failed because the machine could not resolve the provider's host (no network). They are left out of `Fail%`, so a provider is not blamed for a local outage.
- This command never modifies files or applies anything - purely informational, same as `/mm-provider`.
- If `outcomes.jsonl` doesn't exist yet or is empty, say so plainly and note that outcome tracking has no historical backfill - it only reflects usage since the tracking shipped.
- With `--by-command`, the `Total$`/`Avg$/call`/`Eff.$/kept` columns always show `n/a` - `usage.jsonl` records cost per provider call, not per command, so there is no real per-command cost to report; use the plain (non-`--by-command`) view for actual cost numbers.
