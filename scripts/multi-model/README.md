# multi-model scripts

Shared upstream: https://github.com/moogento/multi-model

To import reviewed upstream changes into a project worktree, run
`python3 scripts/multi-model/sync.py --source /path/to/multi-model --target /path/to/project-worktree`.
Reverse source and target to export project improvements into an upstream feature worktree.
Add `--check` to preview. Stage new source files first. Commit `.multi-model-sync.json` with each
sync: it records the last imported content hashes and protects edits on both sides from overwrites.
Conflicts stop the operation before any writes. Review the resulting diff and run tests before pushing.
Only tracked toolkit scripts, tests, skills and commands are shared; credentials and runtime logs stay local.

Node ESM toolkit shared by the Claude and Codex `multi-model` integrations. It lets DeepSeek, GLM/Z.ai,
and opt-in OpenRouter candidates
act as cheap, advisory, non-final helpers for implementation, review, docs, and
explanation while the calling agent applies patches and makes final decisions. See the matching
agent skill for behavioral rules.

## Setup

1. Create `.secrets/multi-model.env` (gitignored) at the main checkout root and fill in
   your keys (DeepSeek: platform.deepseek.com/api_keys, GLM: z.ai/manage-apikey/apikey-list,
   optional OpenRouter: openrouter.ai/settings/keys):
   ```
   DEEPSEEK_API_KEY=sk-...
   GLM_API_KEY=...
   OPENROUTER_API_KEY=...
   # Optional: default Jev decision model (.tools/jev-decide.sh; see .guidelines/ai/jev-decisions.md)
   DECISION_MODEL=~typesafe/jev-latest
   ```
   **OpenRouter-only setup**: developers issued a per-developer Moogento OpenRouter key
   only need `OPENROUTER_API_KEY=sk-or-...`. `deepseek`,
   `deepseek-flash` and `glm` then route automatically through their OpenRouter twins
   (`deepseek-openrouter`, `glm-53-openrouter`) - all `/mm-*` commands and the `/moo`/`/rr`
   review fallbacks work unchanged. These keys carry a monthly budget and are guardrailed
   server-side to `deepseek/deepseek-v4.1-flash`, `deepseek/deepseek-v4-pro-0813`, `z-ai/glm-5.3-flash` and `z-ai/glm-5.2:free` (ZDR providers only) (the `guardrailed` benchmark preset). Any other OpenRouter model
   (the MiniMax/Kimi/Qwen/free-candidate presets, `z-ai/glm-5.2` paid) is rejected by the
   key itself - that's policy, not an outage; those presets need an unrestricted key.
2. Run `/mm-provider` or `node scripts/multi-model/provider-status.js` to confirm what's
   detected (never prints key values).
3. Run `/mm-config` or `node scripts/multi-model/config-check.js` to confirm connectivity
   with a tiny harmless test prompt per provider.

Feature work happens in a dedicated git worktree, and `.secrets/` isn't linked into new
worktrees the way `vendor/` is. If a worktree has no `.secrets/multi-model.env` of its own,
config loading automatically falls back to the main checkout's copy (resolved via git's
shared common dir), so you only need to set keys up once per clone. Set
`MULTI_MODEL_ENV_FILE` to an absolute path to override either lookup.

No `npm install` is needed beyond the repo's existing `dotenv` dependency - everything
else uses Node's built-in `fetch` and `node:test`.

## Cost model & choosing models

Verified against provider docs 2026-09-26 (DeepSeek native prices are peak-hour; off-peak is half) - re-check prices before relying on them:

| Model | Input $/MTok | Output $/MTok | Notes |
|---|---|---|---|
| `deepseek-v4-flash` (default for `deepseek`) | 0.30 | 1.20 | now an alias DeepSeek resolves to `deepseek-flash` (V4.1 Flash); cache hits $0.006 |
| `deepseek-flash` (default for `deepseek-flash`) | 0.30 | 1.20 | DeepSeek V4.1 Flash - the plan and review substitute slot |
| `deepseek-v4-pro` (default for `deepseek-pro`) | 1.32 | 3.96 | DeepSeek V4 Pro - the implementation and test-draft slot; cache hits $0.044 |
| `glm-5.3-flash` (default for `glm`) | 0.075 | 0.25 | Z.ai flash coder for critique, docs, and explanations |
| `glm-4.7` | 0.6 | 2.2 | previous gen, solid for docs |
| `glm-4.7-flash` | free | free | free tier - fine for explanations/drafts |
| `deepseek/deepseek-v4.1-flash` via OpenRouter | 0.30 | 1.20 | guardrailed-key DeepSeek 4.1 Flash; auto-fallback for `deepseek` and `deepseek-flash` |
| `deepseek/deepseek-v4-pro-0813` via OpenRouter | 1.32 | 3.96 | guardrailed-key DeepSeek V4 Pro (same version DeepSeek serves); auto-fallback for `deepseek-pro`; ZDR providers only, typical price shown |
| `z-ai/glm-5.3-flash` via OpenRouter | 0.04 | 0.50 | guardrailed-key GLM flash; auto-fallback for `glm`; reasoning cannot be disabled, only lowered |
| `z-ai/glm-5.2:free` via OpenRouter | free | free | guardrailed-key free fallback for throwaway drafts; rides a shared upstream pool, so 429s are routine - retry later rather than debugging config |
| `z-ai/glm-5.3-flash` via OpenRouter (BYOK) | unknown | unknown | optional route to the same GLM flash model as direct `glm`; BYOK-pinned to provider `z-ai`, price depends on OpenRouter account/provider settings |
| `minimax/minimax-m3` via OpenRouter | 0.30 | 1.20 | cheap long-context planner/reviewer candidate |
| `moonshotai/kimi-k2.7-code` via OpenRouter | 0.74 | 3.50 | coding-focused alternate implementer candidate |
| `qwen/qwen3-coder` via OpenRouter | 0.22 | 1.80 | cheap 1M-context coding-agent candidate |
| `nvidia/nemotron-3-ultra-550b-a55b:free` via OpenRouter | free | free | free long-context sanity-pass candidate |
| `poolside/laguna-m.1:free` via OpenRouter | free | free | free coding-agent experiment |
| `cohere/north-mini-code:free` via OpenRouter | free | free | free small coding-agent experiment |

- The legacy `deepseek-chat` / `deepseek-reasoner` aliases are deprecated on 2026-07-24;
  the `deepseek` default is already `deepseek-v4-flash`, `deepseek-flash` runs DeepSeek
  V4.1 Flash and `deepseek-pro` runs DeepSeek V4 Pro (`deepseek-v4-pro`).
- OpenRouter ignores DeepSeek's native `thinking` field, so the OpenRouter DeepSeek entries
  switch thinking off in review mode with `reasoning: { enabled: false }` instead; without
  it, reviews spent the whole 8192-token budget reasoning and returned no content.
- `roles.implementation` defaults to the separate `deepseek-pro` provider entry, not plain
  `deepseek` - the entry keeps the larger input/output limits and the substitute-review
  a real code draft needs. Plan and review substitutes use `roles.reviewSubstitute`
  (`consensus-review.js --role reviewSubstitute`), which lists `deepseek-flash` and `deepseek-pro`
  during the 2026-09-26 side-by-side trial; set it to the winner to end the trial. `roles.planning` and `roles.benchmark` still
  default to `deepseek` (`deepseek-v4-flash`), and `roles.critique`/`documentation`/
  `explanation` to `glm` (GLM 5.3 Flash), which remain the right tiers for cheaper, more
  disposable drafts (a plan you'll critique yourself, or a side-by-side cost/quality
  comparison).
- Prices above for DeepSeek 4.1 Flash and GLM 5.3 Flash are flash-tier estimates carried
  over from the previous flash generation of the same family. Re-check them at
  platform.deepseek.com and z.ai before relying on `/mm-stats` dollar figures.
- `cheap-implement.js` self-corrects automatically when `roles.critique` (default `glm`) is
  configured: after the `deepseek-pro` draft, GLM critiques it; if any issue is found,
  `deepseek-pro` gets exactly one bounded revision pass, then GLM re-critiques the revision
  for reporting only (never a second revision). This spends free/cheap critique calls to
  catch issues before the calling agent ever sees the draft, cutting its own vetting work.
  Pass `--no-self-correct` to skip straight to the single-shot draft. Any failure in the
  critique/revision path (provider not configured, call error, unparseable JSON, or the
  draft touching a sensitive path) falls back to the best diff already in hand rather than
  blocking or discarding it.
- `cheap-implement.js --mode notes` returns advisory Markdown implementation notes
  (saved under `.<client>/multi-model/drafts/`) instead of an apply-ready diff. The notes
  prompt forbids referencing symbols absent from the provided files and requires a
  "Missing context" section instead of guessing, because outcome logs showed apply-ready
  diffs from truncated context patch hallucinated file content and get rejected wholesale.
  The `/moo` implementation and testing pre-passes always use notes mode; the critique/
  revise loop applies to diff mode only. `--apply` is invalid with notes.
- GLM defaults to patient calls (`timeoutMs=300000`, `retries=2`, `retryDelayMs=10000`)
  because its endpoint intermittently times out or returns 429 on large review prompts.
  Retry delays double per attempt, capped at 120s, and a provider `Retry-After` header wins
  over that computed backoff when present (bounded to a 600s outer ceiling so a hostile or
  malformed header cannot stall the pipeline for hours). When every attempt fails on a
  transient category (timeout, network, 429, overload, 5xx), or the provider's own key is
  simply not set,
  the call automatically re-runs once through the provider named in its `fallbackProvider`
  config - `deepseek` and `deepseek-flash` fall back to `deepseek-openrouter`, `deepseek-pro` to
  `deepseek-pro-openrouter`, and `glm` to `glm-53-openrouter` when `OPENROUTER_API_KEY` is
  configured, and the call/usage logs attribute the rescued call to the fallback provider.
  `provider-status.js` reports a keyless primary whose fallback has a key as
  `OK (via fallback <name>)`, and `isProviderConfigured` counts it as configured, so
  role resolution, review fan-out, and the `/moo` availability gates all work on an
  OpenRouter-only machine. Override via
  `GLM_TIMEOUT_MS`, `GLM_RETRIES`, and `GLM_RETRY_DELAY_MS`, or the matching fields in
  `config.local.json`.
- `consensusReview` queries every configured fan-out provider concurrently, so the wall
  clock is bounded by the slowest single provider rather than the sum of them, and one slow
  provider no longer delays the others. Each call is still capped by its own per-provider
  request timeout and retry/fallback handling.
- GLM defaults to the Coding Plan endpoint,
  `https://api.z.ai/api/coding/paas/v4`, because the generic `api/paas/v4` endpoint is
  not interchangeable with Coding Plan quota. The plan covers `glm-5.3-flash` (the `glm`
  default), `glm-5.3`, `glm-5-turbo`, and `glm-4.7`; do not add Claude-only `[1m]`
  suffixes to OpenAI-compatible model IDs.
- `glm-openrouter` is an optional OpenRouter route to the same model as direct `glm`
  (`z-ai/glm-5.3-flash`), so route comparisons stay like-for-like. Configure
  `OPENROUTER_API_KEY` in `.secrets/multi-model.env`; if you want OpenRouter to spend your
  Z.ai key, add that key in OpenRouter's BYOK provider credentials and set it to always use
  your key for the Z.ai provider. The default request body pins routing to provider `z-ai`
  with fallbacks disabled, so a call through `glm-openrouter` should not silently switch to
  another host. `glm-openrouter` is not in the default review fan-out; use it explicitly
  when comparing routes, or opt it in locally. If uptime is more important than strict
  BYOK/direct routing, override `providers.glm-openrouter.extraBody.provider` in
  `config.local.json` with a provider order and `allow_fallbacks: true`.
- Extra OpenRouter candidates are available as opt-in providers:
  `minimax-openrouter`, `kimi-openrouter`, `qwen-coder-openrouter`,
  `nemotron-free-openrouter`, `poolside-free-openrouter`, and
  `north-code-free-openrouter`. All share `OPENROUTER_API_KEY`, all have
  `"reviewFanout": false`, and all except `glm-openrouter` have `"configCheck": false`
  so `/mm-config` does not spend calls on every experimental route just because the
  OpenRouter key exists. Test them deliberately with `/mm-benchmark --preset
  openrouter-cheap`, `/mm-benchmark --preset openrouter-free`, or `/mm-config --preset
  openrouter-cheap`. Per-developer guardrailed keys reject every model in these presets;
  they need an unrestricted OpenRouter key.
- The OpenRouter candidate defaults sort providers by throughput and allow provider
  fallback inside OpenRouter. This is deliberate for experiments where latency and
  availability matter. Keep `glm-openrouter` pinned to Z.ai when testing BYOK/direct-GLM
  behavior.
- For GLM Coding Plan subscribers, the `pricing`-derived dollar figures `/mm-provider` and
  `/mm-stats` print for `glm` calls are usage volume against a flat-rate plan, not real
  marginal spend - the subscription is a sunk cost regardless of call count. Real
  out-of-pocket cost is `deepseek`/`deepseek-pro` only, both pay-per-token and both on
  flash-tier pricing. This makes it correct to use GLM liberally wherever it adds scrutiny
  (fan-out reviews, the `cheap-implement.js` critique/revise loop below) while staying
  cost-conscious specifically about `deepseek-pro` call volume.
- Every successful HTTP response appends a timestamped JSONL record (provider, model,
  tokens, latency, estimated cost from the merged provider `pricing` config - a
  `config.local.json` override wins) to the selected client's `multi-model/usage.jsonl` in the MAIN
  checkout (gitignored), so worktree calls land in the same ledger and survive worktree
  cleanup. `/mm-provider` prints the running per-provider totals; calls with no pricing
  or no usage data are counted separately as "unknown cost" rather than folded into $0.
  Set `MULTI_MODEL_USAGE_LOG=off` (or `0`/`false`) to disable, or point it at another
  path - both the writer and `/mm-provider` honor it. When a provider reports the
  cache-hit/cache-miss prompt-token split (DeepSeek does), hits are priced at
  `cachedInputPerMTok`; otherwise all input tokens use the cache-miss rate. Estimates
  only apply when the call used the provider's `defaultModel` - a call with an
  overridden `DEEPSEEK_MODEL`/`GLM_MODEL`/`--provider` model is counted as unknown cost
  rather than priced at the wrong rate (to price a custom model, override `defaultModel`
  and `pricing` together in `config.local.json`).
- Every provider request also appends a timestamped JSONL record to
  `.<client>/multi-model/calls.jsonl`, including successful calls, failed calls, timeout
  categories, retry attempts, timeout/retry settings used, latency, input size and
  truncation counts, review command/run/phase correlation, requested and serving provider,
  reasoning-output size, and token/cost data when the provider returned usage. This ledger
  intentionally records no prompt text, response text, or keys. `/mm-provider` prints
  running reliability totals, while `/mm-stats` folds call failure rate and latency into
  the keep-rate/cost view. This is the ledger to use when deciding whether the multi-model
  assist is saving Claude/Codex work or burning wall time on provider failures.
- Provider responses and errors now carry input metadata back to callers. Input limits apply
  to the whole message list, not independently to every message. If a provider's review
  input budget truncates a prompt, `/mm-review` includes the
  truncation counts in the JSON result and the summary line says to treat valid reviews as
  incomplete. A parsed JSON review from a truncated prompt is not consensus; it is a rough,
  partial review of only the prefix that reached the provider.
- `consensus-review.js` splits large diffs before calling providers, preferring file-level
  `diff --git` boundaries and slicing only when one file diff is larger than the review
  budget. Chunked results are merged into one review per provider and include `chunked`,
  `chunks`, and, if any chunk failed, `partial`/`chunkErrors` metadata. A partial review is
  useful signal, not a clean pass.
- Review calls reserve context-window room for the completion, disable DeepSeek thinking,
  cap output at 8192 tokens by default, request low reasoning effort from GLM routes,
  require JSON response mode on the principal DeepSeek and GLM routes, and ask for at most
  five prioritised issues per chunk.
  These review-only settings do not reduce implementation or explanation budgets.
- `consensus-review.js` also sends the full post-change content of each chunk's changed
  files alongside the diff (at least 40% of the post-prompt input budget is reserved for
  it - small diffs leave more room; files that don't fit get an explicit omission note,
  missing/unreadable/secret-bearing files get an unavailability note, and the same
  sensitive-path filters apply as everywhere else - a complete new file already present in
  the diff is not duplicated as file context, and a secret-shaped line anywhere in a
  file keeps that file's whole body local). Reviewers are instructed to verify against
  that content before flagging anything missing, and to keep files whose entry is only a
  note in diff-only judgment - outcome logs showed most dropped review findings were
  diff-chunking artifacts, flagging code that exists just outside the hunk. Omitted paths
  are reported back as `contextOmitted`; a review served by a fallback provider carries
  `servedBy`. Pass `--no-file-context` to send bare diffs.
- Every review issue must carry an `evidence` field quoting the exact provided line(s)
  that prove the claim - the prompt routes anything the reviewer cannot quote into
  `risks`. Callers treat evidence-free issues as risks, and risks as advisory notes
  worth at most a one-line existence check (see
  `.guidelines/workflow/multi-model-review-fallback.md`, "Weighing fallback output") - the
  2026-08 stage-10 outcome data showed investigating every speculative risk cost more
  than the reviews returned.
- `consensus-review.js` injects `.guidelines/workflow/multi-model-review-known-false-positives.md`
  (when present, capped at 6000 chars) into every review prompt as a known-non-issues
  brief. When investigating a finding refutes it in a generalizable way (framework
  default, spec behavior, codebase convention), append one line there so no future
  review repeats it.
- After a review with findings, `consensus-review.js` runs one bounded self-verify pass
  per provider when the findings reference files the provider was not shown (context
  omitted, or outside the diff): it resolves up to 12 of those files through the same
  sensitive-path filters and asks the same provider to keep-with-evidence or retract
  each of its own findings, never adding new ones. The result carries
  `selfVerified: true`, the `selfVerifyFiles` list, and `retracted` counts; a failed
  pass keeps the original findings and sets `selfVerifyError` (treat those findings as
  unverified). Pass `--no-self-verify` to skip it.
- Every judged multi-model output (a diff actually applied or rejected, a review verdict,
  a docs/plan draft kept or thrown away) is recorded, per provider, to the selected
  client's `multi-model/outcomes.jsonl` in the same main-checkout location as
  `usage.jsonl` - `apply-guarded-diff.js` logs the diff-apply case automatically; every
  other command logs it itself via `log-outcome.js` as its last step. `/mm-stats`
  aggregates both logs into a per-provider keep-rate and effective cost-per-kept-output.
  Set `MULTI_MODEL_OUTCOME_LOG=off` (or `0`/`false`) to disable, or point it at another
  path - same convention as `MULTI_MODEL_USAGE_LOG`.
- `/moo` runs assists automatically only with standing consent: set
  `MULTI_MODEL_MOO_AUTO=1` alongside the keys. A configured key alone keeps multi-model
  manual (`/mm-*` commands), because `/moo`'s diff captures send working-tree content -
  including uncommitted and untracked changes - to the third-party provider.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `DEEPSEEK_API_KEY` | (none) | Required to enable DeepSeek |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com` | DeepSeek API base |
| `DEEPSEEK_MODEL` | `deepseek-v4-flash` | DeepSeek model id |
| `DEEPSEEK_FLASH_MODEL` | `deepseek-flash` | DeepSeek model id for the `deepseek-flash` (plan and review substitute) entry - DeepSeek V4.1 Flash |
| `DEEPSEEK_PRO_MODEL` | `deepseek-v4-pro` | DeepSeek model id for the `deepseek-pro` (implementation and test draft) entry - DeepSeek V4 Pro |
| `DEEPSEEK_MAX_INPUT_CHARS` | `300000` | DeepSeek whole-request input limit outside review mode |
| `DEEPSEEK_PRO_MAX_INPUT_CHARS` | `400000` | DeepSeek Pro whole-request input limit outside review mode |
| `DEEPSEEK_PRO_MAX_OUTPUT_TOKENS` | `32768` | DeepSeek Pro `max_tokens`, sized so implementation notes and long reviews finish instead of ending with `finish_reason=length` |
| `DEEPSEEK_MAX_OUTPUT_TOKENS` | `32768` | DeepSeek flash `max_tokens` - the call ledger showed 23 review/prepass calls ending `finish_reason=length` at the old 16384 global cap |
| `GLM_API_KEY` | (none) | Required to enable GLM/Z.ai |
| `GLM_BASE_URL` | `https://api.z.ai/api/coding/paas/v4` | GLM API base; override only for non-coding-plan API usage |
| `GLM_MODEL` | `glm-5.3-flash` | GLM model id |
| `GLM_MAX_INPUT_CHARS` | `600000` | Direct GLM whole-request input limit outside review mode; global fallback remains `MULTI_MODEL_MAX_INPUT_CHARS` |
| `GLM_REASONING_EFFORT` | `max` | Direct GLM reasoning effort request field |
| `GLM_ACCEPT_LANGUAGE` | `en-US,en` | Direct GLM `Accept-Language` header |
| `OPENROUTER_API_KEY` | (none) | Optional: enables the `glm-openrouter` provider |
| `OPENROUTER_BASE_URL` | `https://openrouter.ai/api/v1` | OpenRouter API base |
| `OPENROUTER_GLM_MODEL` | `z-ai/glm-5.3-flash` | OpenRouter model id for GLM |
| `OPENROUTER_GLM_MAX_INPUT_CHARS` | `600000` | OpenRouter GLM whole-request input limit outside review mode, matched to direct GLM so fallback calls aren't truncated harder |
| `OPENROUTER_DEEPSEEK_MODEL` | `deepseek/deepseek-v4.1-flash` | OpenRouter model for `deepseek-openrouter` (guardrailed) |
| `OPENROUTER_DEEPSEEK_PRO_MODEL` | `deepseek/deepseek-v4-pro-0813` | OpenRouter model for `deepseek-pro-openrouter` (guardrailed) |
| `OPENROUTER_GLM53_MODEL` | `z-ai/glm-5.3-flash` | OpenRouter model for `glm-53-openrouter` (guardrailed) |
| `OPENROUTER_GLM_FREE_MODEL` | `z-ai/glm-5.2:free` | OpenRouter model for `glm-free-openrouter` (guardrailed, free) |
| `OPENROUTER_MINIMAX_MODEL` | `minimax/minimax-m3` | OpenRouter MiniMax benchmark/review candidate |
| `OPENROUTER_KIMI_MODEL` | `moonshotai/kimi-k2.7-code` | OpenRouter Kimi coding candidate |
| `OPENROUTER_QWEN_CODER_MODEL` | `qwen/qwen3-coder` | OpenRouter Qwen coding candidate |
| `OPENROUTER_NEMOTRON_FREE_MODEL` | `nvidia/nemotron-3-ultra-550b-a55b:free` | OpenRouter free long-context candidate |
| `OPENROUTER_POOLSIDE_FREE_MODEL` | `poolside/laguna-m.1:free` | OpenRouter free Poolside coding candidate |
| `OPENROUTER_NORTH_CODE_FREE_MODEL` | `cohere/north-mini-code:free` | OpenRouter free Cohere coding candidate |
| `OPENROUTER_HTTP_REFERER` | `https://m2-moogento.com` | Optional OpenRouter attribution header |
| `OPENROUTER_APP_TITLE` | `Moogento multi-model` | Optional OpenRouter attribution header |
| `MULTI_MODEL_MAX_INPUT_CHARS` | `150000` | Whole-request input limit for providers without their own `maxInputChars` |
| `MULTI_MODEL_MAX_OUTPUT_TOKENS` | `16384` | `max_tokens` sent to providers |
| `MULTI_MODEL_REVIEW_MAX_INPUT_CHARS` | `180000` | Conservative whole-request review limit for providers without `reviewMaxInputChars` |
| `MULTI_MODEL_REVIEW_MAX_OUTPUT_TOKENS` | `8192` | Review-only completion limit for providers without `reviewMaxOutputTokens` |
| `MULTI_MODEL_CLIENT` | `claude` | State namespace: `claude` or `codex` |
| `MULTI_MODEL_USAGE_LOG` | `<main checkout>/.<client>/multi-model/usage.jsonl` | Usage log path; `off`/`0`/`false` disables |
| `MULTI_MODEL_CALL_LOG` | `<main checkout>/.<client>/multi-model/calls.jsonl` | Provider reliability log path; `off`/`0`/`false` disables |
| `MULTI_MODEL_OUTCOME_LOG` | `<main checkout>/.<client>/multi-model/outcomes.jsonl` | Outcome log path; `off`/`0`/`false` disables |
| `MULTI_MODEL_MOO_AUTO` | (unset) | `1`/`true` = standing consent for `/moo` to auto-run assists (sends diffs to providers); unset = manual `/mm-*` only |
| `MULTI_MODEL_ENV_FILE` | `.secrets/multi-model.env` | Override the dotenv file path |
| `MULTI_MODEL_LOCAL_CONFIG` | `.<client>/multi-model/config.local.json` | Machine-local config overlay path; `off`/`0`/`false` disables (the test suite sets `off` so results never depend on machine config) |

Provider entries in `config.default.json` also support `timeoutMs`, `retries`,
`retryDelayMs`, and matching environment override names (`timeoutMsEnv`, `retriesEnv`,
`retryDelayMsEnv`). The built-in environment variables are:

| Variable | Default | Purpose |
|---|---|---|
| `DEEPSEEK_TIMEOUT_MS` | `60000` | DeepSeek request timeout |
| `DEEPSEEK_RETRIES` | `1` | DeepSeek retry count for timeout/network/429/5xx failures |
| `DEEPSEEK_RETRY_DELAY_MS` | `2000` | Delay between DeepSeek retries |
| `DEEPSEEK_PRO_TIMEOUT_MS` | `120000` | DeepSeek Pro request timeout |
| `DEEPSEEK_PRO_RETRIES` | `1` | DeepSeek Pro retry count |
| `DEEPSEEK_PRO_RETRY_DELAY_MS` | `2000` | Delay between DeepSeek Pro retries |
| `GLM_TIMEOUT_MS` | `300000` | GLM request timeout |
| `GLM_RETRIES` | `2` | GLM retry count |
| `GLM_RETRY_DELAY_MS` | `10000` | Base delay between GLM retries (doubles per attempt) |
| `OPENROUTER_GLM_TIMEOUT_MS` | `180000` | OpenRouter GLM request timeout |
| `OPENROUTER_GLM_RETRIES` | `1` | OpenRouter GLM retry count |
| `OPENROUTER_GLM_RETRY_DELAY_MS` | `3000` | Delay between OpenRouter GLM retries |

Role - provider mapping lives in `config.default.json` (`planning`, `implementation`,
`documentation`, `explanation`, `benchmark`), overridable per-project in the gitignored
`.claude/multi-model/config.local.json` or `.codex/multi-model/config.local.json`, selected by
`MULTI_MODEL_CLIENT`. To route critique/docs through OpenRouter instead of direct Z.ai, set
`roles.critique`, `roles.documentation`, or `roles.explanation` to `glm-openrouter` in
`config.local.json`; for reviews, pass `--providers deepseek,glm-openrouter` or locally set
`providers.glm-openrouter.reviewFanout` to `true`. `mm-review` and `mm-consensus` both run
`consensus-review.js`, which queries every configured provider returned by
`defaultFanoutProviders()` rather than reading a role - the difference between the two
commands is only in what the calling agent is instructed to do with the results afterward.
Benchmark presets live in `benchmarkPresets`: `default`, `openrouter-cheap`,
`openrouter-free`, `openrouter-all`, and `cost-control`. `benchmark.js --preset <name>`
uses one of those lists unless `--providers` is passed, in which case the explicit provider
list wins. `config-check.js` accepts the same `--preset` and `--providers` selectors, plus
`--all` when you intentionally want to probe every provider entry.

## Example commands

```bash
node scripts/multi-model/cheap-plan.js --task "add a wishlist widget" --files "app/code/Moogento/Wishlist/Block/Widget.php"
node scripts/multi-model/cheap-implement.js --provider deepseek --task "add null check" --files "app/code/Moogento/Foo/Model/Bar.php"
node scripts/multi-model/alt-implement.js --task "implement rate limiting" --files "app/code/Moogento/Foo/Model/Limiter.php"
node scripts/multi-model/consensus-review.js --diff path/to.diff --file-context --task "security review of the new endpoint"
node scripts/multi-model/explain.js --files "app/code/Moogento/Foo/Model/Bar.php" --symbol "Bar::calculate"
node scripts/multi-model/docs.js --task "document the new REST endpoint" --files "app/code/Moogento/Foo/Api/BarInterface.php" --mode markdown
node scripts/multi-model/provider-status.js
node scripts/multi-model/config-check.js
node scripts/multi-model/benchmark.js --task "explain the difference between == and === in PHP"
node scripts/multi-model/benchmark.js --task "review this approach" --preset openrouter-cheap
node scripts/multi-model/config-check.js --preset openrouter-free
node scripts/multi-model/apply-guarded-diff.js --diff .claude/multi-model/patches/2026-07-01T12-00-00-000Z-a1b2c3-deepseek.diff
MULTI_MODEL_CLIENT=codex node scripts/multi-model/apply-guarded-diff.js --diff .codex/multi-model/patches/2026-07-01T12-00-00-000Z-a1b2c3-deepseek.diff
node scripts/multi-model/log-outcome.js --command mm-review --provider glm --outcome dropped --reason-category not-selected --reason "recommended a broader refactor than scope allowed"
node scripts/multi-model/outcome-stats.js --by-command --reasons
```

Run the test suite from the repo root:

```bash
node --test scripts/multi-model/test/*.test.js
```

(A bare directory path fails with `MODULE_NOT_FOUND` on some Node versions - the glob form above works consistently.)

## Security model

- Explicit `$multi-model`, `/mm-*`, or non-`none` `--multi-model=<mode>` use authorizes the scoped
  provider calls through the user's configured DeepSeek, GLM/Z.ai, and OpenRouter accounts, including named
  authentication, authorization, security, payment, and licensing code. `MULTI_MODEL_MOO_AUTO=1`
  supplies the same standing consent for automatic `/moo` assists. No separate approval is needed
  solely because the code belongs to one of those domains. Provider output remains advisory, and
  Codex retains final authority.
- DeepSeek, GLM, and OpenRouter-hosted models are called only via `fetch` inside these scripts - never given `Bash`,
  `Edit`, or `Write` tool access, never spawned as agents.
- Every diff a provider returns must pass `diff-guard.js` before `apply-guarded-diff.js`
  will run `git apply`. The guard hard-blocks (no silent pass-through) on: invalid unified
  diff syntax, path traversal, sensitive paths (`.env*`, `.secrets/**`, `*credentials*`,
  `*secret*`, `*.pem`, `*.key`, `id_rsa*`, `composer.lock`, `package-lock.json`,
  `.git/**`, `.ssh/**`, `.npmrc`, `.composer/auth.json`), `vendor/**`/`node_modules/**`,
  secret-shaped added strings (no override, ever), unmentioned network-call additions, and
  oversized single-file deletions. Four of these categories - sensitive paths,
  `vendor/**`/`node_modules/**`, network calls, and oversized deletions - accept explicit
  `--allow-*` flags; secret-shaped strings, invalid syntax, and path traversal never do. No
  command wires an `--allow-*` flag in automatically; only a human/agent decision passes
  one.
- The same sensitive-path patterns are also enforced on the send side: `prompt-builder.js`'s
  `readFilesForPrompt()` checks every `--files` path against `diff-guard.js`'s exported
  `SENSITIVE_PATH_PATTERNS` before reading it, and substitutes a `[skipped: ...]` placeholder
  instead of inlining the content into a provider prompt when a path matches.
- `readFilesForPrompt()` also rejects any `--files` path that resolves outside the repo root
  or the OS temp dirs (`os.tmpdir()` and `/tmp`, which macOS keeps distinct - both stay
  allowed because `moo.md`'s commit-message/PR-draft steps legitimately pass a captured diff
  from a temp file), substituting the same kind of `[skipped: ...]` placeholder for paths
  like `/etc/passwd` or another checkout's files. Containment is checked on the
  symlink-resolved path, so a temp-dir symlink cannot smuggle in an outside file.
- API keys live only in `process.env`, sourced from `.secrets/multi-model.env`
  (gitignored). No script writes a key to a file, config, log, or diff. Error messages
  include only the provider's own error text and an HTTP status code, never our request
  headers. The usage log records token counts and cost only - never prompt or response
  content.
- `/mm-provider` and `/mm-config` report presence/success only - never a key value.

## Overflow routing (whole-CLI, separate lane)

The per-developer OpenRouter key can also route an entire agent CLI when its native
subscription runs out. This is a **different safety lane** from the `/mm-*` assist layer:
in overflow mode the cheap model IS the agent - it gets shell and file-write access - so
none of this toolkit's never-give-write-access rules apply to it, and none of its
guardrails (diff-guard, sensitive-path filters, outcome logging) run. Use it as a
stand-in agent when Codex/Claude limits are exhausted, not as a way to run `/mm-*` flows.

- **Codex CLI**: add a custom provider to `~/.codex/config.toml` and switch models when
  quota runs out:
  ```toml
  model_provider = "openrouter"
  model = "deepseek/deepseek-v4.1-flash"

  [model_providers.openrouter]
  name = "OpenRouter"
  base_url = "https://openrouter.ai/api/v1"
  env_key = "OPENROUTER_API_KEY"
  ```
- **Claude Code**: route through OpenRouter's Anthropic-compatible gateway:
  ```
  export ANTHROPIC_BASE_URL="https://openrouter.ai/api"
  export ANTHROPIC_AUTH_TOKEN="$OPENROUTER_API_KEY"
  export ANTHROPIC_API_KEY=""
  ```
- Guardrailed keys accept only the four allowlisted models in either mode. Prefer
  `deepseek/deepseek-v4.1-flash` for difficult long-horizon coding sessions and
  `deepseek/deepseek-v4-flash` for everyday overflow.
- Match the model to the task even inside a subscription: mechanical chained commands
  (commit messages, formatting passes) belong on the cheap tier (Codex terra/medium
  effort, or a flash-class model), with the expensive tier reserved for planning,
  review, and hard implementation.

## How to add another provider

1. Add an entry to `config.default.json` under `providers` with `baseUrlEnv`,
   `defaultBaseUrl`, `apiKeyEnv`, `modelEnv`, `defaultModel`, and (optionally) `pricing`,
   `headers`, and `extraBody` fields for usage-log cost estimates and provider-specific
   request metadata (see the
   `deepseek`/`glm` entries as a template - the format is provider-agnostic as long as
   the API is OpenAI-compatible `/chat/completions`). Every CLI script calls
   `callChatCompletion(config, providerName, ...)` directly with this provider-name
   string, so this config entry alone makes the new provider callable end to end -
   including `/mm-alt` and `/mm-review`/`/mm-consensus`, which default to every provider
   `defaultFanoutProviders()` (in `config.js`) returns. If the new entry is an alternate
   tier of an existing provider rather than a genuinely independent vendor (the way
   `deepseek-pro` is to `deepseek`), set `"reviewFanout": false` on it so it stays
   role-bound instead of doubling that vendor's cost in every all-providers command - an
   explicit `--providers` list can still include it deliberately.
2. Optionally add a thin wrapper file (`your-provider.js`) mirroring
   `deepseek.js`/`glm.js`: `callYourProvider(messages, options)` -
   `callChatCompletion(config, 'your-provider', messages, options)`. No script imports
   `callDeepSeek`/`callGlm` today, so this step is not required for the provider to work -
   it's useful mainly as a convenience export or if you want matching coverage like
   `provider-wrappers.test.js`.
3. Reference the provider name in `config.roles.*` wherever you want it used. Singular
   `--provider your-provider` works on `cheap-plan.js`, `cheap-implement.js`,
   `explain.js`, and `docs.js`; `consensus-review.js` and `benchmark.js` take plural
   `--providers your-provider,other-provider` instead.
4. No changes needed to `providers.js`, `diff-guard.js`, `alt-implement.js`, or any
   `mm-*.md` command - they're all provider-name-agnostic.

## Known limitations

- Default model IDs and prices were verified against provider docs on 2026-07-05 -
  providers move fast; re-verify with `/mm-config` against your actual account/plan.
- The heuristic diff-guard rules (secret-shaped strings, network-call detection,
  large-deletion detection) are pattern-based, not semantic. They reduce risk; they don't
  replace an authoritative agent read of every diff before applying it - that read, plus the
  explicit apply confirmation required by every `/mm-*` command, is the actual safety
  boundary. diff-guard is defense-in-depth on top of it, not a sandbox.
- The generic secret-keyword assignment pattern (`key = "..."`) only matches quoted
  values; well-known token formats (AWS, GitHub, Slack, Stripe, Google, npm, JWT, PEM) are
  still caught unquoted.
- `consensus-review.js`'s JSON parsing falls back to raw text on malformed provider
  output - callers must handle both shapes (`review.issues` vs. `review.raw`).
- Transient failures (429, 5xx, network errors, timeouts) are retried according to the
  selected provider's timeout/retry settings; other 4xx errors fail immediately.
  The timeout covers response headers and the complete response-body read. A body stream
  ending with `terminated` is retryable rather than being mislabeled as malformed JSON.
  Multi-model assist remains best-effort, not guaranteed, even when correctly configured.
- A response that hits its output limit is cut off by the provider. A reasoning-only
  `finish_reason=length` response is logged as `output-limit` and is not repeated through
  an equivalent fallback route; it is never recorded as a successful empty response. A truncated diff
  usually fails diff-guard's syntax check (truncation on
  an exact file boundary can pass - another reason every diff gets read before applying).
  If that happens, narrow the task or raise the limit rather than retrying the same
  request.
- Outcome logging outside the diff-apply case (`mm-plan`, `mm-review`, `mm-consensus`,
  `mm-explain`, markdown-mode `mm-docs`, and every pipeline stage) depends on Claude
  actually calling `log-outcome.js` as its last step - the same class of risk as any
  prose-instruction rule. Only the whole-diff-apply case (`mm-implement`, `mm-alt`,
  diff-mode `mm-docs`) is logged automatically with no reliance on that.
- `/mm-stats`'s `Eff.$/kept` is an aggregate approximation - `outcomes.jsonl` and
  `usage.jsonl` are joined by provider totals, not by a per-call correlation id - so it's
  only meaningful over a reasonable sample size, not for a single run.
- `/mm-stats --all-repos` requires the user to pass sibling repo paths explicitly; it
  doesn't auto-discover other checkouts on disk.
- If a diff is rejected by `diff-guard.js` and then deliberately retried with an
  `--allow-*` flag and applied, `apply-guarded-diff.js` logs both the rejection and the
  later apply as separate outcomes for the same patch - each CLI invocation is an
  independent, real event and the script has no memory of an earlier attempt. This
  slightly understates keep-rate for the rare, human-supervised retry path (never
  automatic, per the rules above); a "final disposition only" version would need
  cross-invocation state this design deliberately doesn't have.
- Any test that calls `applyGuardedDiff()` (or anything that internally reaches
  `appendOutcome()`/`log-outcome.js`) must pass an explicit `outcomeLogFile` override (a
  temp path, or `false` to disable) - the default log path resolves to the MAIN checkout's
  `outcomes.jsonl`, shared across every worktree of the repo. A real incident:
  `diff-guard.test.js` called `applyGuardedDiff(diffPath, { repoRoot })` at six sites with
  no override, and every test run across every worktree appended synthetic
  `dropped`/`rejected-by-diff-guard` records to the real ledger - 168 lines of pure test
  noise in one repo, 90 in the other, with zero real signal, before anyone ran `/mm-stats`
  and noticed. The same applies to `usageLogFile` for anything that calls
  `callChatCompletion()` directly in a test.
- When a `build*Messages()` prompt builder combines small, load-bearing content (a task
  description, reviewer feedback, a short prior diff) with large, variable-length content
  (a file dump via `readFilesForPrompt`), put the small content FIRST in the message.
  `callChatCompletion()`'s truncation (`MULTI_MODEL_MAX_INPUT_CHARS`) keeps only the first
  N characters and drops the tail - if the load-bearing content were appended after the
  file dump, a large file set could silently truncate it away entirely, so a follow-up
  call (e.g. `cheap-implement.js`'s revision pass) can end up missing the very feedback it
  exists to act on.
- A diff that fails `scanDiffForLeaks()` must never become an accepted final result, even
  in a path that doesn't send it anywhere external. `cheap-implement.js`'s self-correction
  loop originally skipped the free re-critique on a leaky revision but still returned that
  revision as the function's result - correct about not leaking it to GLM, wrong to accept
  it as "the" output instead of falling back to the still-safe original draft.

  The leak guard's job is stopping a bad diff from being trusted anywhere downstream, not
  just from leaving the process.

## Recommended workflow

1. Claude/Codex creates or approves the plan.
2. `/mm-implement` generates a first-pass diff.
3. Claude/Codex reviews the diff.
4. Tests/lint run.
5. `/mm-review` or `/mm-consensus` checks for missed issues.
6. Claude/Codex makes the final edits and decision.
7. Whichever step above didn't already apply a diff (so wasn't logged automatically) logs
   its own kept/dropped outcome; `/mm-stats` shows which providers are actually worth
   keeping.
