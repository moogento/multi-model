---
description: Get a second-opinion review of the current diff from every configured provider (same underlying script as /mm-consensus); you synthesize the results into one recommendation and give the final verdict
argument-hint: [--diff path (defaults to current git diff)]
allowed-tools: Read, Bash(git diff:*), Bash(node scripts/multi-model/consensus-review.js:*), Bash(node scripts/multi-model/log-outcome.js:*), Bash(node .tools/jev-decide.mjs:*), Bash(mkdir -p .temp/jev)
model: sonnet
---

# Multi-Model Review (second opinion)

**Target**: $ARGUMENTS (defaults to the current unstaged `git diff` if no `--diff` given)

## Process

1. Run:
   ```bash
   node scripts/multi-model/consensus-review.js [--diff <path>] [--task "<context>"] [--file-context] [--no-file-context]
   ```
2. Read the JSON results - each provider returns `{issues, risks, missing}` or a raw-text fallback if it didn't return valid JSON.
   By default the script also sends the full post-change content of each changed file (sensitive-path and secret-value filters still apply; files that don't fit the budget are replaced with an omission note and reported as `contextOmitted`) so reviewers stop flagging code that exists outside the diff hunks. Pass `--no-file-context` when the file contents themselves must not leave the machine, or when `--diff` points at a patch that does not match the current working tree (committed ranges, patches from another checkout) - the context is read from disk and would contradict the diff. Passing `--diff` disables file context by default - pass `--file-context` whenever the patch is applied on disk (e.g. a diff generated from the working tree).
3. **You give the final verdict.** Before cross-checking, order the reported issues with Jev Gate 3 and merge duplicates across providers with Gate 4 (`.guidelines/workflow/jev-decision-gates.md`); advisory only, and `JEV_STATUS: unavailable` means cross-check as usual. Cross-check every reported issue against the actual diff yourself before repeating it to the user - these are opinions from a cheaper model, not verified findings. Drop anything that's wrong or not applicable; keep and elaborate on anything real.
4. Present your own review, clearly marking which points originated from the multi-model pass vs. your own analysis.
5. **Log the outcome for every provider that returned a review** - `/mm-review` never applies anything, so this is always a self-report, one call per provider:
   ```bash
   node scripts/multi-model/log-outcome.js --command mm-review --provider <provider> --outcome <kept|kept-edited|partial|dropped> --reason-category <not-selected|wrong-approach|out-of-scope|other> --reason "<one line: which of its points you used, if any>"
   ```
   `kept`/`kept-edited` if you incorporated its findings into your verdict; `partial` if only some of its points were real; `dropped` if none of it held up.

## Rules

- Never treat a multi-model finding as CRITICAL/blocking without verifying it yourself first.
- If no provider is configured, say so and fall back to a normal review yourself - don't fail the command.
