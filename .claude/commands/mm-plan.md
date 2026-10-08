---
description: Get a cheap first-pass implementation plan from the configured planning provider (DeepSeek/GLM), then critique it before recommending anything
argument-hint: [task-description] --files path1,path2
allowed-tools: Read, Glob, Grep, Bash(node scripts/multi-model/cheap-plan.js:*), Bash(node scripts/multi-model/log-outcome.js:*)
model: sonnet
---

# Multi-Model Plan Draft

**Task**: $ARGUMENTS

## Process

1. Parse `$ARGUMENTS` for the task description and a `--files` list. If `--files` is missing, use Glob/Grep yourself to find the 3-6 most relevant files first, then pass them explicitly - do not let the script guess.
2. Run:
   ```bash
   node scripts/multi-model/cheap-plan.js --task "<task>" --files "<comma-separated files>"
   ```
   If it prints `multi-model plan failed: ... is not configured ...`, tell the user to run `/mm-provider` and stop - do not fall back to writing the plan yourself under this command's banner.
3. Read the returned Markdown plan.
4. **You must add a critique section** before presenting anything to the user: what you agree with, what's wrong or missing (architecture, security, Magento conventions, test coverage), and what you'd change. This is not optional - the draft is a cheap first pass, not a recommendation on its own.
5. Present your critique-adjusted recommendation to the user. If the draft plan is fundamentally wrong, say so plainly and offer to write a real plan via `/plan` instead.
6. **Log the outcome:**
   ```bash
   node scripts/multi-model/log-outcome.js --command mm-plan --provider <provider> --outcome <kept|kept-edited|dropped> --reason-category <applied-clean|applied-with-edits|wrong-approach|out-of-scope|other> --reason "<one-line summary of your critique verdict>"
   ```
   Use `kept` if your critique broadly endorsed the draft, `kept-edited` if you used it but changed real substance, `dropped` if you wrote a real plan yourself instead.

## Rules

- Never present the raw draft as your own plan without the critique section.
- Never use this for security-sensitive, payment/licensing, auth, or credential-handling planning - do that yourself.
