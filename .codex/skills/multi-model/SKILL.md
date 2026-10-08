---
name: multi-model
description: Use when a cheaper/alternative LLM (DeepSeek, GLM/Z.ai, or OpenRouter) should do first-pass implementation, boilerplate, test scaffolding, repetitive edits, alternatives, docs, explanations, or a second-opinion review, including when the app reports less than 10% Codex usage remaining. Explicit invocation authorizes scoped read-only sharing through the user's configured provider accounts, including security-sensitive, auth, payment, and licensing code; credentials and production data remain excluded, and Codex keeps final authority.
---

# Multi-Model (DeepSeek / GLM / OpenRouter assist)

## What this is

A toolkit (`scripts/multi-model/`) and eleven slash-command-compatible scripts
(`/mm-plan`, `/mm-implement`, `/mm-alt`, `/mm-review`, `/mm-consensus`,
`/mm-explain`, `/mm-docs`, `/mm-provider`, `/mm-config`, `/mm-benchmark`,
`/mm-stats`) that call DeepSeek and GLM/Z.ai over their OpenAI-compatible
chat-completions APIs to produce first-pass drafts, alternative approaches, and
second opinions. Two key setups are supported: direct DeepSeek/GLM keys, or a
per-developer Moogento OpenRouter key alone - with only `OPENROUTER_API_KEY`
set, the default providers route automatically through their OpenRouter twins
(`deepseek-openrouter` for `deepseek` and `deepseek-flash`, `deepseek-pro-openrouter` for `deepseek-pro`, `glm-53-openrouter` for `glm`) and
every command, role, and moo/rr fallback gate works unchanged
(`provider-status.js` shows these as `OK (via fallback ...)`). Per-developer
keys carry a monthly budget and are guardrailed server-side to
`deepseek/deepseek-v4.1-flash`, `deepseek/deepseek-v4-pro-0813`, `z-ai/glm-5.3-flash` and
`z-ai/glm-5.2:free`, ZDR providers only (the `guardrailed` benchmark preset); a
rejection of any other OpenRouter model on such a key is policy, not an outage.
Additional OpenRouter candidate providers exist for benchmarked experiments on
unrestricted keys, but are not default fanout. Codex remains the only thing with
shell or file-write access at any point in this flow. Defaults: `deepseek-pro`
(DeepSeek V4 Pro) for implementation drafts, the `reviewSubstitute` role (`deepseek-flash`
and `deepseek-pro` side by side during the 2026-09-26 trial) for plan and review substitutes,
`deepseek-v4-flash` for planning drafts and benchmarking, and `glm-5.3-flash`
(GLM 5.3 Flash) for docs and explanations.

Run commands from the repository root. Prefix every toolkit command with
`MULTI_MODEL_CLIENT=codex` so Codex state stays under `.codex/multi-model`;
never omit the prefix. Every successful response's tokens and estimated cost
land in the main checkout's `.codex/multi-model/usage.jsonl` (one ledger across
worktrees); `/mm-provider` shows the running totals. Every provider request also
lands in `.codex/multi-model/calls.jsonl` with success/failure, timeout
category, attempts, latency, input-size/truncation metadata, and review
run/phase correlation but no prompt text or keys; this is the reliability
ledger for deciding whether the assist layer is saving work or burning wall
time. Every judged output (applied,
kept-with-edits, partial, or dropped) is also recorded, per provider, to
`.codex/multi-model/outcomes.jsonl`; `/mm-stats` compares providers by
keep-rate, failure rate, latency, and effective cost per kept output.

## Start safely

1. Run `MULTI_MODEL_CLIENT=codex node scripts/multi-model/provider-status.js`
   to show configured providers, selected models, role mapping, usage totals,
   and auto-assist state without exposing keys.
2. Run `MULTI_MODEL_CLIENT=codex node scripts/multi-model/config-check.js`
   only when connectivity needs verification. It sends a tiny harmless prompt
   and incurs a small provider charge.
3. Never print, infer, copy, or log an API key. Keys must remain in the
   gitignored `.secrets/multi-model.env` file.
4. Treat `MULTI_MODEL_MOO_AUTO=0` or an unset value as manual-only mode. Key
   presence alone is not consent to send repository content.

### Authorization for configured provider accounts

An explicit `$multi-model`, `/mm-*`, or non-`none` `--multi-model=<mode>` request authorizes the
provider calls needed for that scoped workflow through the user's configured DeepSeek, GLM/Z.ai,
and OpenRouter accounts. `MULTI_MODEL_MOO_AUTO=1` supplies the same standing consent for the
documented automatic `/moo` assists. That authorization includes named diffs and explicit file context containing
authentication, authorization, security, payment, or licensing logic. Do not pause for another
approval solely because the code belongs to one of those categories.

Authorization remains scope-bound. Never send credentials, secret-bearing paths, customer or
production data, generated output, dependencies, environment files, or runtime and deployment
state. The send-side sensitive-path and secret-value guards remain mandatory. Mere provider
configuration or API-key presence grants no consent.

## Codex quota conservation

Run `node .tools/codex-plan-check.mjs --threshold 10` once near the start of a substantial task and
read its `CODEX_PLAN_*` markers. Do not recompute allowance from `usedPercent`: the tool also treats
`individualLimit`, a reached rate limit or spend control, and disallowed ordinary usage as below the
floor. When it reports `CODEX_PLAN_AVAILABLE: false`, use configured DeepSeek, GLM, or OpenRouter
providers for every eligible bounded draft, explanation, documentation pass, or second-opinion
review. Prefer DeepSeek Pro for implementation and review, and GLM for documentation and
explanations; use their OpenRouter twins when the direct provider is unavailable. Inside `/moo`,
`$moo`, and `$m2-moo`, the narrower rule in `references/multi-model.md` of those skills wins:
substitute only the call that would otherwise run.

Low-quota routing is a priority, not a consent bypass. Use it only when the user explicitly requested
multi-model use or standing auto-assist consent is enabled; an explicit opt-out still wins. It does
not transfer final decisions, shell access, file writes, secret data, or any work excluded by this
skill. Keep prompts narrow and give explicit files or a saved diff. Codex must still inspect provider
output, apply edits, run checks, and decide the result. When the tool reports `CODEX_PLAN_STATUS: unknown`,
do not infer a value from task length or model behavior; use the normal delegation heuristic
instead.

## When to use it

- First-pass implementation or boilerplate (`/mm-implement`, prefer DeepSeek).
  Prefer `--mode notes` (advisory Markdown that Codex verifies and rewrites) over
  an apply-ready diff whenever the change spans several files or the provider may
  not see every file in full. Outcome logs show blind diffs get dropped; grounded
  notes survive.
- Alternative approaches worth comparing before committing (`/mm-alt`).
- Cheap first-pass plans you'll critique yourself (`/mm-plan`).
- UX copy, documentation drafts, and explanations (`/mm-docs`, `/mm-explain`,
  prefer GLM).
- Second opinions and cross-provider comparison (`/mm-review`, `/mm-consensus`)
  - both run the same script and query every configured provider, not just GLM.
  Review calls use a bounded review profile: conservative input limits with
  completion-token headroom, an 8192-token output cap, DeepSeek thinking
  disabled, low GLM reasoning, JSON
  response mode, and at most five prioritised issues per chunk. Complete new
  files already present in a diff are not duplicated through `--file-context`.
- Cheap refactor drafts.

## Delegate-by-default heuristic

The point of this skill is cost reduction, so don't wait to be asked. Hand the
first pass to a cheap model when ALL of these hold:

- The change needs no new design decisions from the draft model - a plan exists,
  or the task is mechanical (boilerplate, test scaffolding, repetitive edits,
  doc drafts, straightforward refactors).
- You can name the target files up front - `--files` is always explicit, never
  guessed.
- The work isn't on the "When NOT to use it" list below.
- A provider is configured (`/mm-provider` - skip silently and work normally if
  not).

When any of these fail, write it yourself: a draft you must largely rewrite
costs more than it saves. Exploratory, cross-cutting, or design-heavy work stays
with Codex.

A specific case worth naming: when the source material is already literal code
(a plan that specifies exact snippets/diffs for every step, not prose
describing intent), a first-pass draft from a cheap model adds no signal -
there's nothing left to draft, only to transcribe, and the draft costs more to
vet than it saves. Skip it and say so plainly ("plan is code-complete, draft
adds no signal") rather than running it as a checklist item. Plans written via
the `writing-plans` skill meet this bar by default (every task step includes
real code), so this is the common case, not an edge case - check it every time,
don't assume "multi-model is on" alone means a draft is useful. A real incident:
an orchestrator stage called `cheap-implement.js` with only a bare task
description, ignoring an already-complete plan sitting right there, and produced
a draft that was materially worse (missing fields, missing safety checks) than
what the plan already specified.

## Select a workflow

Use explicit target files. Never let an external model discover arbitrary
repository content.

| User intent | Command |
|---|---|
| Draft a plan | `MULTI_MODEL_CLIENT=codex node scripts/multi-model/cheap-plan.js --task "<task>" --files "<paths>"` |
| Draft implementation notes | `MULTI_MODEL_CLIENT=codex node scripts/multi-model/cheap-implement.js --mode notes --task "<task>" --files "<paths>" --provider deepseek` |
| Draft an implementation diff | `MULTI_MODEL_CLIENT=codex node scripts/multi-model/cheap-implement.js --task "<task>" --files "<paths>" --provider deepseek` |
| Compare implementation alternatives | `MULTI_MODEL_CLIENT=codex node scripts/multi-model/alt-implement.js --task "<task>" --files "<paths>"` |
| Review a saved diff | `MULTI_MODEL_CLIENT=codex node scripts/multi-model/consensus-review.js --task "<context>" --diff "<path>" --file-context` (add `--file-context` whenever the patch is applied on disk) |
| Review the current working diff | `MULTI_MODEL_CLIENT=codex node scripts/multi-model/consensus-review.js --task "<context>"` |
| Explain code | `MULTI_MODEL_CLIENT=codex node scripts/multi-model/explain.js --files "<paths>" --symbol "<symbol>"` |
| Draft documentation | `MULTI_MODEL_CLIENT=codex node scripts/multi-model/docs.js --task "<task>" --files "<paths>" --mode markdown` |
| Draft a documentation diff | `MULTI_MODEL_CLIENT=codex node scripts/multi-model/docs.js --task "<task>" --files "<paths>" --mode diff` |
| Compare providers | `MULTI_MODEL_CLIENT=codex node scripts/multi-model/benchmark.js --task "<task>" --providers deepseek,glm` |
| Compare cheap OpenRouter candidates | `MULTI_MODEL_CLIENT=codex node scripts/multi-model/benchmark.js --task "<task>" --preset openrouter-cheap` |
| Compare free OpenRouter candidates | `MULTI_MODEL_CLIENT=codex node scripts/multi-model/benchmark.js --task "<task>" --preset openrouter-free` |

## Advisory-only and prohibited boundaries

Security-sensitive changes, auth or ACL flows, payment, and licensing logic may be reviewed only as
advisory input under the authorization above. Codex must still perform the authoritative review and
make every final decision.

Do not use provider calls for:

- Credentials, secrets, customer data, or production-only data.
- Production deployment decisions or runtime/deployment state.
- Architecture/scope planning that determines what gets built. `/mm-plan`
  produces a *draft* you critique, never a plan you hand off unexamined.

## Rules

- Never give DeepSeek, GLM, or OpenRouter-hosted models shell or file-write access, ever.
- Alternative models return structured JSON, Markdown, or unified diffs only -
  nothing else is a valid output shape.
- Codex applies every patch, always through `apply-guarded-diff.js` (never a raw
  `git apply` of multi-model output).
- Diffs are saved to `.codex/multi-model/patches/` before any apply decision is
  made.
- Ask the user before applying unless they explicitly asked for the change to be
  applied in their original request.
- API keys live in environment variables only (`.secrets/multi-model.env`,
  gitignored) - never print, log, or write one anywhere.
- Prefer DeepSeek for implementation-heavy patches and test boilerplate.
- Prefer GLM for alternative ideas, UX copy, documentation, and second opinions
  (`glm-4.7-flash` is free on the direct API, and `glm-free-openrouter` /
  `z-ai/glm-5.2:free` is the free route on OpenRouter keys - fine choices for
  throwaway explanations).
- Direct GLM/Z.ai remains the default route when its key is present
  (subscription volume is sunk cost). Without it, `glm` falls back to
  `glm-53-openrouter` (`z-ai/glm-5.3-flash`) automatically. `glm-openrouter` runs
  the same `z-ai/glm-5.3-flash` model through OpenRouter (BYOK-pinned to provider
  `z-ai`) and stays an opt-in route for like-for-like route comparisons - it is
  not in the default review fan-out, so include it explicitly.
- OpenRouter candidates are opt-in only: `minimax-openrouter`,
  `kimi-openrouter`, `qwen-coder-openrouter`, `nemotron-free-openrouter`,
  `poolside-free-openrouter`, and `north-code-free-openrouter`. Use them for
  benchmarks or explicit second opinions, not as blocking reviewers until
  `/mm-stats` shows they save Codex/Claude work. All of them are outside the
  per-developer key guardrail - on such a key they fail by design; do not retry
  or treat it as a provider outage.
- Use `--preset guardrailed` for the four per-developer-key models, `--preset
  openrouter-cheap` for MiniMax/Kimi/Qwen, `--preset
  openrouter-free` for the free candidates, and explicit `--providers` when a
  workflow needs an exact model list. Free OpenRouter providers are disposable
  signal only; do not treat them as consensus.
- Direct GLM uses the Z.ai Coding Plan endpoint by default (`/api/coding/paas/v4`);
  `glm` usage dollars are API-equivalent subscription volume, not marginal
  spend.
- Always read a generated diff yourself before applying it - never relay one
  unexamined.
- If a draft looks cut off mid-diff, it hit the output-token cap - narrow the
  task, raise `MULTI_MODEL_MAX_OUTPUT_TOKENS` (or the provider's
  `maxOutputTokens`), or switch to `--mode notes`; never hand-repair a
  truncated diff.
- Review issues carry an `evidence` field quoting the provided code that proves
  the claim, and reviews with findings referencing unseen files get one
  self-verify pass (`selfVerified`/`retracted` in the result; `--no-self-verify`
  skips). Treat evidence-free issues as risks, and risks as advisory notes worth
  a one-line existence check at most - never a full investigation each (see the
  "Weighing fallback output" section of
  `.guidelines/workflow/multi-model-review-fallback.md`). When you refute a finding in a
  generalizable way, add one line to
  `.guidelines/workflow/multi-model-review-known-false-positives.md` - it is injected
  into every future review prompt.
- When weighing findings from `/mm-review`, `/mm-consensus`, or substitute reviewers, follow
  `.guidelines/workflow/jev-decision-gates.md` Gates 3 and 4 through the repo's
  `.tools/jev-decide.mjs`. Resolve file, line, and quoted evidence in code first. Gate 3 only
  orders surviving findings for local verification; Gate 4 merges same-file, within-20-line
  pairs at `same_defect >= 0.6`, retaining both sources and the higher severity. Unavailable
  answers fail open. Jev never dismisses a finding, marks a review clean, or clears a blocker.
  `--multi-model=none` or `MOO_JEV=0` disables Jev; report `jev: ran N, unavailable M` when used,
  or "off".
- If `/mm-review` or `/mm-consensus` reports truncated input, treat every
  returned review as incomplete even when the JSON is valid. Do not call it
  consensus or a clean pass.
- If `/mm-review` or `/mm-consensus` reports `chunked` output with `partial` or
  `chunkErrors`, use the successful chunks as signal only. The review did not
  cover the full diff cleanly.
- A reasoning-only response ending with `finish_reason=length` is an
  `output-limit` failure, not a successful empty review. It is not repeated
  through an equivalent fallback route. Response-body reads remain covered by
  the provider timeout, and interrupted `terminated` body streams are retried
  like other transient network failures.
- After applying anything from this skill, run the project's normal tests/lint -
  this skill's output is a draft, not verified working code.
- When summarizing finished work to the user, say plainly what came from an
  alternative model vs. your own analysis/edits.
- Every `/mm-*` command that produces a judged output ends with a step that logs
  the outcome via `log-outcome.js` (a successful diff apply logs itself
  automatically) - `/mm-stats` is only useful if this actually happens, so don't
  skip it.

## See also

- `scripts/multi-model/README.md` - setup, environment variables, current model
  pricing, usage/cost tracking, CLI usage, security model, how to add another
  provider.
- `docs/superpowers/specs/2026-07-01-multi-model-skill-design.md` - full design
  rationale.
