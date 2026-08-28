# Decision Record: Gate Anthropic thinking variants by model generation with envelope-safe budgets

Status: implemented

## Problem

Anthropic extended thinking split into incompatible generations, and the runtime's single budget formula could not serve all of them:

- The pinned `@ai-sdk/anthropic@2.0.56` zod-rejected `thinking: { type: "adaptive" }` and `effort: "max" | "xhigh"`, so the existing 4.6/4.7 variant branches threw `invalid anthropic provider options` at request time — every adaptive-era Claude model was broken.
- The budget fallback (`max = min(31_999, output - 1)`) left exactly 1 token of visible-answer room on 8k/16k/32k-output models. The AI SDK adds `budgetTokens` back into the wire `max_tokens`, so the request was legal but `streamText`'s `maxOutputTokens` (the text-only budget) was 1: responses truncated after one visible token (`stop_reason: max_tokens`), with thinking consuming the rest.
- Current official docs confirm the generation split: `enabled + budget_tokens` is supported on 4.5-era and earlier, deprecated-but-working on 4.6, and **rejected with HTTP 400 on 4.7+**, which require `thinking: { type: "adaptive" }` + `output_config.effort` (five levels). Unknown/unversioned ids and Opus 4.5 are the only budget-era models that legitimately carry effort declarations.
- The shared-context branch of `maxOutputTokens` could compute a negative text budget when the catalog output limit exceeded the context window, producing `max_tokens < budget_tokens` on the wire.

## Decision

- Bump `@ai-sdk/anthropic` to `2.0.98` (same 2.x line, `LanguageModelV2`, compatible with the pinned `ai@5`): it backfills `adaptive` thinking (with `display`) and the full `effort` enum (`low`/`medium`/`high`/`xhigh`/`max`), so the gated variants below pass the SDK validator.
- Gate Anthropic variants by model generation parsed from the API id (`claude-{opus|sonnet|haiku}-{major}[-{minor}]`):
  - **adaptive** (4.7+, 5.x): variants `low`/`medium`/`high`/`xhigh`/`max` → `{ thinking: { type: "adaptive", display: "summarized" }, effort }`.
  - **dual** (4.6): variants `low`/`medium`/`high`/`max` → `{ thinking: { type: "adaptive" }, effort }` (budget still works but is deprecated).
  - **budget** (3.x–4.5 and unversioned/unknown ids): variants derived from the effective output cap (`context - 32_000` headroom when shared-context, capped at the global output max):
    - `high = clamp(min(16_000, floor(cap/2 - 1)), min 1_024)`
    - `max = min(31_999, max(high, cap - 1_024))`
    - no variants at all when `cap < 2_048` (a legal budget plus text floor cannot fit).
  - Catalog `reasoningEfforts` declarations are trusted only for unknown/unversioned ids and Opus 4.5 (the sole extended-only model that also supports effort); recognizable earlier generations stay on budgets.
- The `max` tier is now distinct from `high` (e.g. 32k output → 30_976 vs 15_999) and always leaves ≥ 1_024 text tokens, fixing the text-starvation bug and the `max ≡ high` collapse.
- Wire-level regression tests assert: every budget is ≥ 1_024 and < the effective cap with ≥ 1_024 text room across `envelope ∈ {2047, 2048, 2049, 8192, 16384, 32000, 64000, 128000}`; 4.7+ models never receive `budgetTokens`; ≤4.5 models never receive `adaptive`; adaptive variants pass the locked SDK validator with the expected `output_config.effort`.

## Alternatives considered

- **Upgrade to `ai` 6/7 with `@ai-sdk/anthropic` 3.x/4.x.** Rejected for this change: it drags a major `ai` version and a dozen `@ai-sdk/*` packages into the same PR for capability (server-side compaction, fallbacks) we do not need yet, and the 2.x patch bump already unlocks adaptive + effort.
- **Pure models.dev directory gating (`reasoning_efforts`).** Rejected as the single source of truth: catalog annotations lag model releases and are absent for user-defined relays; the version regex from the API id is deterministic and local, with catalog efforts retained as the override for unknown ids and Opus 4.5.
- **pi-style fixed budget table (`1024/2048/8192/16384`, `max` collapsed into `high`).** Rejected: it loses the `max` tier semantics users already have in the UI, and the ecosystem anchors (`16_000`/`31_999`, opencode/Claude Code) match the official guidance to start complex tasks at 16k and avoid budgets beyond 32k.
- **Leave the catalog `reasoningEfforts` short-circuit for all budget-era models.** Rejected: a bare `{ effort }` is rejected on models that do not support effort (4.5 and earlier), which is why the trust window is narrowed to unknown ids and Opus 4.5.

## Consequences

- Adaptive-era Claude models (4.6/4.7/4.8/5.x) work again and expose effort variants that pass the SDK validator; 4.7+ no longer sends `enabled + budget_tokens` (which the API rejects).
- Budget-era models get a text-safe thinking split: `max` keeps ≥ 1_024 text tokens, `high` keeps ≥ half the cap, and envelopes below 2_048 emit no thinking variants instead of an illegal request.
- The shared-context corner can no longer produce a negative text budget because the envelope is clamped with the same headroom the `maxOutputTokens` branch uses.
- Users on `max` with 8k/16k/32k models see a behavior change (less thinking, real answer text) — the intended fix; sessions that switch variants lose one round of prompt cache (budget is part of the cached prefix), unchanged from before.
- `@ai-sdk/anthropic` `2.0.56 → 2.0.98` is a patch-line bump; behavior differences inside the 2.x line beyond adaptive/effort were not individually audited and are covered by the provider test suite.
