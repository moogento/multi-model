---
name: multi-model
description: "Use when a cheaper LLM (DeepSeek, GLM/Z.ai) should do first-pass implementation, boilerplate, test scaffolding, repetitive edits, alternative approaches, docs, explanations, or a second-opinion review, while Claude/Codex keep planning, patching, security, and every final decision. Triggers include 'use deepseek for this', 'get a second opinion from glm', 'cheap first pass', /mm-implement, /mm-review, or the --multi-model flag. Security-sensitive, auth, payment, and licensing code is advisory-only and needs the repo's data-sharing consent; never credentials or production-deployment work."
version: 1.1.0
---

# Multi-Model (DeepSeek / GLM / OpenRouter assist)

## What this is

A toolkit (`scripts/multi-model/`) and eleven slash commands (`/mm-plan`, `/mm-implement`,
`/mm-alt`, `/mm-review`, `/mm-consensus`, `/mm-explain`, `/mm-docs`, `/mm-provider`,
`/mm-config`, `/mm-benchmark`, `/mm-stats`) that call DeepSeek and GLM/Z.ai over their
OpenAI-compatible chat-completions APIs to produce first-pass drafts, alternative
approaches, and second opinions. Two key setups are supported: direct DeepSeek/GLM keys,
or a per-developer Moogento OpenRouter key alone - with only `OPENROUTER_API_KEY` set,
the default providers route automatically through their OpenRouter twins
(`deepseek-openrouter` for `deepseek` and `deepseek-flash`, `deepseek-pro-openrouter` for `deepseek-pro`, `glm-53-openrouter` for `glm`) and every
command, role, and moo/rr fallback gate works unchanged (`/mm-provider` shows these as
`OK (via fallback ...)`). Per-developer keys carry a monthly budget and are guardrailed
server-side to `deepseek/deepseek-v4.1-flash`, `deepseek/deepseek-v4-pro-0813`, `z-ai/glm-5.3-flash` and `z-ai/glm-5.2:free` (ZDR providers only) (the `guardrailed`
benchmark preset); a rejection of any other OpenRouter model on such a key is policy,
not an outage. Additional OpenRouter candidate providers exist for benchmarked
experiments on unrestricted keys, but are not default fanout. Claude Code remains the
only thing with shell or file-write access at any point in this flow. Defaults:
the `deepseek-flash` provider (DeepSeek 4.1 Flash, up to $0.30/$1.20 per MTok) for
plan and review substitutes (alongside `deepseek-pro` in the `reviewSubstitute` role during the
2026-09-26 side-by-side trial), `deepseek-pro` (DeepSeek V4 Pro, up to $1.32/$3.96 per MTok)
for implementation and test drafts, `deepseek` (the V4.1 Flash alias) for planning
drafts and benchmarking, `glm-5.3-flash` (GLM 5.3 Flash, $0.075/$0.25
per MTok) for docs and explanations - all far cheaper than doing the first pass
at Claude prices. Every successful response's tokens and estimated cost land
in the main checkout's
`.claude/multi-model/usage.jsonl` (one ledger across worktrees); `/mm-provider` shows the
running totals. Every provider request also lands in `.claude/multi-model/calls.jsonl`
with success/failure, timeout category, attempts, latency, and input-size/truncation
metadata but no prompt text or keys; this is the reliability ledger for deciding whether
the assist layer is saving work or burning wall time. Every judged output (applied,
kept-with-edits, partial, or dropped) is
also recorded, per provider, to `.claude/multi-model/outcomes.jsonl`; `/mm-stats` compares
providers by keep-rate, failure rate, latency, and effective cost per kept output.

## When to use it

- First-pass implementation or boilerplate (`/mm-implement`, prefer DeepSeek). Prefer
  `--mode notes` (advisory Markdown the implementer verifies and rewrites) over an
  apply-ready diff whenever the change spans several files or the provider may not see
  every file in full - outcome logs show blind diffs get dropped; grounded notes survive.
- Alternative approaches worth comparing before committing (`/mm-alt`).
- Cheap first-pass plans you'll critique yourself (`/mm-plan`).
- UX copy, documentation drafts, and explanations (`/mm-docs`, `/mm-explain`, prefer GLM).
- Second opinions and cross-provider comparison (`/mm-review`, `/mm-consensus`) - both run
  the same script and query every configured provider, not just GLM.
- Cheap refactor drafts.

## Delegate-by-default heuristic

The point of this skill is cost reduction, so don't wait to be asked. Hand the first pass
to a cheap model when ALL of these hold:

- The change needs no new design decisions from the draft model - a plan exists, or the
  task is mechanical (boilerplate, test scaffolding, repetitive edits, doc drafts,
  straightforward refactors).
- You can name the target files up front - `--files` is always explicit, never guessed.
- The work isn't on the "When NOT to use it" list below.
- A provider is configured (`/mm-provider` - skip silently and work normally if not).

When any of these fail, write it yourself: a draft you must largely rewrite costs more
than it saves. Exploratory, cross-cutting, or design-heavy work stays with Claude.

A specific case worth naming: when the source material is already literal code (a plan
that specifies exact snippets/diffs for every step, not prose describing intent), a
first-pass draft from a cheap model adds no signal - there's nothing left to draft, only to
transcribe, and the draft costs more to vet than it saves. Skip it and say so plainly
("plan is code-complete, draft adds no signal") rather than running it as a checklist item.
Plans written via the `writing-plans` skill meet this bar by default (every task step
includes real code), so this is the common case, not an edge case - check it every time,
don't assume "multi-model is on" alone means a draft is useful. A real incident: an
orchestrator stage called `cheap-implement.js` with only a bare task description, ignoring
an already-complete plan sitting right there, and produced a draft that was materially
worse (missing fields, missing safety checks) than what the plan already specified.

## When NOT to use it (final authority stays with Claude/Codex)

- Security-sensitive changes, auth flows, ACL/permission logic.
- Payment or licensing logic.
- Credential handling of any kind.
- Production deployment decisions.
- Architecture/scope planning that determines what gets built - `/mm-plan` produces a
  *draft* you critique, never a plan you hand off unexamined.

For these, a multi-model pass may run as an *advisory pre-pass only* (see the
`--multi-model` flag in `moo.md`/`rr.md` - auto-enabled there only with the standing
consent var `MULTI_MODEL_MOO_AUTO=1`, never on key presence alone; this file is shared
verbatim across repos, so the local orchestrator command may be named differently), and
the real Claude/Codex subagent still runs its full check afterward and is the only source
of a blocking verdict.

Whether that advisory pass may send the code at all is decided by the repo's `AGENTS.md`
(for example an "External Code Review Data Sharing" section): where it grants explicit
consent for the invoked mode, do not ask again solely because the code is security,
auth, payment, or licensing logic. Credentials, secrets, and production data stay excluded.

## Rules

- Never give DeepSeek, GLM, or OpenRouter-hosted models shell or file-write access, ever.
- Alternative models return structured JSON, Markdown, or unified diffs only - nothing
  else is a valid output shape.
- Claude Code applies every patch, always through `apply-guarded-diff.js` (never a raw
  `git apply` of multi-model output).
- Diffs are saved to `.claude/multi-model/patches/` before any apply decision is made.
- Ask the user before applying unless they explicitly asked for the change to be applied
  in their original request.
- API keys live in environment variables only (`.secrets/multi-model.env`, gitignored) -
  never print, log, or write one anywhere.
- Prefer DeepSeek for implementation-heavy patches and test boilerplate.
- Prefer GLM for alternative ideas, UX copy, documentation, and second opinions
  (`glm-4.7-flash` is free on the direct API, and `glm-free-openrouter` /
  `z-ai/glm-5.2:free` is the free route on OpenRouter keys - fine choices for throwaway
  explanations).
- Direct GLM/Z.ai remains the default route when its key is present (subscription volume
  is sunk cost). Without it, `glm` falls back to `glm-53-openrouter` (`z-ai/glm-5.3-flash`)
  automatically. `glm-openrouter` runs the same `z-ai/glm-5.3-flash` model through
  OpenRouter (BYOK-pinned to provider `z-ai`) and stays an opt-in route for like-for-like
  route comparisons - it is not in the default review fan-out, so include it explicitly.
- OpenRouter candidates are opt-in only: `minimax-openrouter`,
  `kimi-openrouter`, `qwen-coder-openrouter`, `nemotron-free-openrouter`,
  `poolside-free-openrouter`, and `north-code-free-openrouter`. Use them for
  benchmarks or explicit second opinions, not as blocking reviewers until
  `/mm-stats` shows they save Claude/Codex work. All of them are outside the
  per-developer key guardrail - on such a key they fail by design; do not retry or
  treat it as a provider outage.
- Use `/mm-benchmark --preset guardrailed` for the four per-developer-key models,
  `/mm-benchmark --preset openrouter-cheap` for MiniMax/Kimi/Qwen,
  `/mm-benchmark --preset openrouter-free` for the free candidates, and explicit
  `--providers` when a workflow needs an exact model list. Free OpenRouter
  providers are disposable signal only; do not treat them as consensus.
- Direct GLM uses the Z.ai Coding Plan endpoint by default (`/api/coding/paas/v4`);
  `glm` usage dollars are API-equivalent subscription volume, not marginal spend.
- Always read a generated diff yourself before applying it - never relay one unexamined.
- If a draft looks cut off mid-diff, it hit the output-token cap - narrow the task, raise
  `MULTI_MODEL_MAX_OUTPUT_TOKENS` (or the provider's `maxOutputTokens`), or switch to
  `--mode notes`; never hand-repair a truncated diff.
- Review issues carry an `evidence` field quoting the provided code that proves the
  claim, and reviews with findings referencing unseen files get one self-verify pass
  (`selfVerified`/`retracted` in the result; `--no-self-verify` skips). Treat
  evidence-free issues as risks, and risks as advisory notes worth a one-line existence
  check at most - never a full investigation each (see the "Weighing fallback output"
  section of `.guidelines/workflow/multi-model-review-fallback.md`). When you refute a finding in
  a generalizable way, add one line to
  `.guidelines/workflow/multi-model-review-known-false-positives.md` - it is injected into every
  future review prompt.
- If `/mm-review` or `/mm-consensus` reports truncated input, treat every returned review
  as incomplete even when the JSON is valid. Do not call it consensus or a clean pass.
- If `/mm-review` or `/mm-consensus` reports `chunked` output with `partial` or
  `chunkErrors`, use the successful chunks as signal only. The review did not cover the
  full diff cleanly.
- After applying anything from this skill, run the project's normal tests/lint - this
  skill's output is a draft, not verified working code.
- When summarizing finished work to the user, say plainly what came from an alternative
  model vs. your own analysis/edits.
- Every `/mm-*` command that produces a judged output ends with a step that logs the
  outcome via `log-outcome.js` (a successful diff apply logs itself automatically) -
  `/mm-stats` is only useful if this actually happens, so don't skip it.

## See also

- `scripts/multi-model/README.md` - setup, environment variables, current model pricing,
  usage/cost tracking, CLI usage, security model, how to add another provider.
- `docs/superpowers/specs/2026-07-01-multi-model-skill-design.md` - full design rationale.
