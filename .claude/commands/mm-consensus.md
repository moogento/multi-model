---
description: Run the same task/review through every configured provider and compare agreements, disagreements, risks, and gaps; you decide the final direction
argument-hint: [task-description] [--diff path]
allowed-tools: Read, Bash(git diff:*), Bash(node scripts/multi-model/consensus-review.js:*), Bash(node scripts/multi-model/log-outcome.js:*), Bash(node .tools/jev-decide.mjs:*), Bash(mkdir -p .temp/jev)
model: sonnet
---

# Multi-Model Consensus

**Task**: $ARGUMENTS

## Process

1. Run:
   ```bash
   node scripts/multi-model/consensus-review.js --task "<task>" [--diff <path>] [--providers deepseek,glm] [--file-context] [--no-file-context]
   ```
   If no `--diff` is given, this defaults to the current unstaged `git diff` plus untracked files - staged changes (via `git add`) are excluded. Passing `--diff` disables file context by default - pass `--file-context` whenever the patch is applied on disk (e.g. a diff generated from the working tree).
2. For each provider's result, note: what they agree on, where they disagree, what risks only one of them flagged, and what neither flagged that you can see yourself.
3. Write a synthesis: agreements (highest confidence), disagreements (needs your judgment call - make it and say why), risks worth escalating to the user, and gaps neither model caught.
4. **You decide the final direction.** Before cross-checking, order the reported issues with Jev Gate 3 and merge duplicates across providers with Gate 4 (`.guidelines/workflow/jev-decision-gates.md`); advisory only, and `JEV_STATUS: unavailable` means cross-check as usual. The providers' output is input to your judgment, never a vote that outvotes you.
5. **Log the outcome for every provider in the consensus** - one call per provider, same shape as `/mm-review`:
   ```bash
   node scripts/multi-model/log-outcome.js --command mm-consensus --provider <provider> --outcome <kept|kept-edited|partial|dropped> --reason-category <not-selected|wrong-approach|out-of-scope|other> --reason "<one line: which of its points made it into your synthesis>"
   ```

## Rules

- If fewer than 2 providers are configured, say so explicitly - a "consensus" of one isn't a consensus, treat it as a single second opinion instead (same caveats as `/mm-review`).
