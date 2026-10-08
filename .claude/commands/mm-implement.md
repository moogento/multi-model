---
description: Generate a first-pass unified diff from the configured implementation provider (DeepSeek by default); review before applying
argument-hint: [task-description] --files path1,path2 [--apply]
allowed-tools: Read, Glob, Grep, Bash(node scripts/multi-model/cheap-implement.js:*), Bash(node scripts/multi-model/apply-guarded-diff.js:*), Bash(git diff:*), Bash(git status:*), Bash(node scripts/multi-model/log-outcome.js:*)
model: sonnet
---

# Multi-Model Implementation Draft

**Task**: $ARGUMENTS

## Process

1. Parse `$ARGUMENTS` for the task and a `--files` list of the files this change should touch.
2. Run:
   ```bash
   node scripts/multi-model/cheap-implement.js --task "<task>" --files "<files>" [--provider deepseek|glm]
   ```
   This specific invocation (no `--apply`) never applies anything by itself - see step 5 for why `--apply` is never passed to the script directly. It prints the saved patch path under `.claude/multi-model/patches/`.

   Add `--mode notes` to get advisory Markdown implementation notes (saved under `.claude/multi-model/drafts/`) instead of a patch - prefer it whenever the change spans several files or the provider is likely to see truncated context, since notes survive imperfect context where an apply-ready diff gets rejected. Notes mode skips steps 4-5 (there is nothing to apply); read the notes, write the code yourself, then log the outcome:
   ```bash
   node scripts/multi-model/log-outcome.js --command mm-implement --provider <provider> --outcome <kept|kept-edited|partial|dropped> --reason-category <applied-clean|applied-with-edits|not-selected|wrong-approach|out-of-scope|other> --reason "<one line: which notes shaped the code>"
   ```
   If the script warns `finish_reason=length`, the notes are cut off - treat anchors and code blocks near the end as unreliable.
3. **Read the diff file yourself** (`Read` tool) before doing anything else. Check it against the task: does it touch only relevant files, does it look architecturally sound, does anything look security-sensitive or off?
4. Decide whether to apply:
   - Only apply without asking if the user's original request explicitly told you to apply the change.
   - In every other case - including when they just described a task with no mention of review - **summarize the diff and ask the user before applying.**
5. To apply, always use the two-step flow. Never pass `--apply` to `cheap-implement.js` itself - each run of that script calls the AI provider fresh, so `--apply` there would apply a newly generated diff, not the one you just read. Instead, apply the exact saved patch file through the dedicated guard script - and never `git apply` the raw file yourself:
   ```bash
   node scripts/multi-model/apply-guarded-diff.js --diff <patch-path> --command mm-implement
   ```
   If it's rejected, read the violations. Only add `--allow-vendor` / `--allow-sensitive-paths` / `--allow-network` / `--allow-large-deletion` if you've personally verified that specific change is intentional and safe - never pass these automatically.
6. After applying, you are fully responsible for the result: fix anything wrong, extend anything incomplete, and run the project's normal tests/lint before considering the task done.
7. **Log the outcome if you did *not* apply anything.** A successful apply in step 5 is already logged automatically by `apply-guarded-diff.js` - nothing more to do there. If the user declined, or you rejected the diff yourself before ever asking:
   ```bash
   node scripts/multi-model/log-outcome.js --command mm-implement --provider <provider> --outcome dropped --reason-category user-declined --reason "<short reason>"
   ```
   Use `wrong-approach`, `hallucinated-api`, `style-mismatch`, `out-of-scope`, or `other` instead of `user-declined` if you were the one who rejected it before ever asking.

## Rules

- This command never gives DeepSeek/GLM shell or file-write access - the diff is generated as text and applied only through the guard above.
- Never use this for security-sensitive, payment/licensing, auth, or credential-handling code - write that yourself.
