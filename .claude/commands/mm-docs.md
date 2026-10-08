---
description: Draft README/docs/comment content with the configured documentation provider (GLM by default); you review before applying
argument-hint: [task-description] --files path1,path2 [--mode diff|markdown]
allowed-tools: Read, Write, Edit, Glob, Grep, Bash(node scripts/multi-model/docs.js:*), Bash(node scripts/multi-model/apply-guarded-diff.js:*), Bash(node scripts/multi-model/log-outcome.js:*)
model: sonnet
---

# Multi-Model Docs Draft

**Task**: $ARGUMENTS

## Process

1. Parse the task, `--files`, and `--mode` (`markdown` for README/guide content, `diff` for inline PHPDoc/comment changes to existing files). Default to `markdown` if unspecified.
2. Run:
   ```bash
   node scripts/multi-model/docs.js --task "<task>" --files "<files>" [--mode diff|markdown]
   ```
3. Read the saved output yourself (`.claude/multi-model/drafts/*.md` or `.claude/multi-model/patches/*.diff`).
4. Edit it to match this repo's actual doc conventions and technical accuracy - verify every claim against the real code, don't trust the draft's accuracy. Fix anything wrong.
5. For `diff` mode, apply only via `node scripts/multi-model/apply-guarded-diff.js --diff <path> --command mm-docs` after your own review, same rules as `/mm-implement`. For `markdown` mode, copy the (corrected) content into the real destination file yourself with `Write`/`Edit`.
6. **Log the outcome.** For `diff` mode, a successful apply in step 5 is already recorded automatically by `apply-guarded-diff.js` - nothing more to do. For `markdown` mode (always self-report, since there's no apply step), or for a `diff`-mode draft you decided not to apply:
   ```bash
   node scripts/multi-model/log-outcome.js --command mm-docs --provider <provider> --outcome <kept|kept-edited|dropped> --reason-category <applied-clean|applied-with-edits|hallucinated-api|style-mismatch|other> --reason "<one line>"
   ```
   `kept-edited` is the common case for markdown drafts - you almost always correct factual claims per the Rules section above.

## Rules

- Never publish a draft's factual claims without verifying them against the actual code first - cheap models confidently invent details.
