---
description: Get a concise technical explanation of selected files/functions from a cheaper model; read-only, never modifies files
argument-hint: --files path1,path2 [--symbol name]
allowed-tools: Read, Glob, Grep, Bash(node scripts/multi-model/explain.js:*), Bash(node scripts/multi-model/log-outcome.js:*)
model: haiku
---

# Multi-Model Explain (read-only)

**Target**: $ARGUMENTS

## Process

1. Parse `--files` (required) and an optional `--symbol` to focus on.
2. Run:
   ```bash
   node scripts/multi-model/explain.js --files "<files>" [--symbol "<name>"]
   ```
3. Present the explanation to the user, noting it came from a cheaper model. If anything looks wrong or you have better context yourself, correct it - don't just relay a wrong explanation.
4. **Log the outcome:**
   ```bash
   node scripts/multi-model/log-outcome.js --command mm-explain --provider <provider> --outcome <kept|kept-edited|dropped> --reason-category <applied-clean|applied-with-edits|hallucinated-api|wrong-approach|other> --reason "<one line>"
   ```
   `kept` if you used the explanation as-is, `kept-edited` if you corrected/extended it before answering, `dropped` if it was wrong enough that you explained it yourself instead.

## Rules

- This command never edits, plans, or reviews - explanation only. If the user actually wants a change, direct them to `/mm-implement` or a normal edit.
