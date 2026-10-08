---
description: Get alternative first-pass implementations from DeepSeek and GLM in parallel, compare them, and recommend a merge strategy
argument-hint: [task-description] --files path1,path2
allowed-tools: Read, Glob, Grep, Bash(node scripts/multi-model/alt-implement.js:*), Bash(node scripts/multi-model/apply-guarded-diff.js:*), Bash(node scripts/multi-model/log-outcome.js:*)
model: sonnet
---

# Multi-Model Alternative Implementations

**Task**: $ARGUMENTS

## Process

1. Parse `$ARGUMENTS` for the task and `--files`.
2. Run:
   ```bash
   node scripts/multi-model/alt-implement.js --task "<task>" --files "<files>"
   ```
   It saves one diff per configured provider under `.claude/multi-model/patches/` and prints a factual files/lines-touched summary per diff. It does **not** recommend a merge strategy - that's your job.
3. Read both diff files yourself.
4. Write your own comparison: what each approach does differently, which is more correct/idiomatic/complete, and a concrete recommendation - either "use diff A", "use diff B", or "take X from A and Y from B, here's the merged result."
5. Do not apply anything under this command. If the user wants the recommended version applied, tell them to confirm, then apply it the same way `/mm-implement` does (`apply-guarded-diff.js --command mm-alt`, never raw `git apply`).
6. **Log the outcome for every provider you compared.** A diff you actually applied is covered automatically by `apply-guarded-diff.js`. For every provider whose diff was NOT applied:
   ```bash
   node scripts/multi-model/log-outcome.js --command mm-alt --provider <provider> --outcome dropped --reason-category not-selected --reason "<why you preferred the other diff>"
   ```
   If neither diff has been applied yet because the user hasn't confirmed, log both once you know the final outcome - don't leave this step for later and forget it.

## Rules

- If only one provider is configured, say so and proceed with just that one diff - don't fail the whole command.
- Never present a provider's diff as your own without having read it end to end first.
