# Decision Record: Preserve prompt accounting and calibration validity

Status: implemented

## Problem

Three independent defects converged on one failure mode: a session grew past the model's input limit and the provider rejected the request outright, because the prompt budget never saw the growth and token accounting could not show that anything was missing.

`RolloutAccounting.summarize()` read provider usage only from a recorded attempt (`attempt?.usage`). Transport recording is best-effort by design: a provider configured with `noProxy` reaches the model through a direct transport that writes no attempt artifacts, and every such call was then counted as unknown even though the AI SDK reported usage on the call record that `RolloutLedger.finishCall` persists as `call.sdkUsage`. The loss tracked the bypass exactly — the affected provider's transport-capture rate fell from about 85% to 0.2% while every other provider stayed at 99.8% — so the one signal that would have explained the missing tokens went missing with them.

`SessionInvoke.buildCalibration()` takes the most recent assistant message with provider-reported input tokens as a baseline and adds a cheap `chars/4` delta of everything appended since, letting `PromptBudgeter.decide()` skip a full tokenizer measurement. It accepted an anchor from any provider and model, so after a model switch the baseline described a different system prompt, tool set, and tokenizer; and it had no branch for `reasoning` parts, so reasoning text appended since the anchor was never counted. Reasoning accumulates every turn, so that under-count grew with conversation length: a gateway-reported input count of 997,665 tokens reconciled only when reasoning was included (about 953.8k estimated) and not when it was excluded (about 344.6k).

`SessionCompaction.isContextExceeded()` gates emergency compaction and the mechanical-summary fallback on a list of substrings. Alibaba Model Studio returns `InvalidParameter: Range of input length should be [1, <N>]` for an over-long prompt, which matched none of them, so an overflow the harness could have absorbed was treated as a fatal provider error.

The `chars/4` heuristic has a measured error profile that bounds where it may be trusted: about -1% on reasoning text, -26% on tool output, and -51% on plain text against real content. That is an acceptable correction to a provider-exact baseline and not a substitute for measurement.

## Decision

`charge()` in `packages/harness/src/session/rollout/accounting.ts` falls back to `call.sdkUsage` when no attempt was recorded, normalized by the new `RolloutUsage.normalizeSdk()` in `packages/harness/src/session/rollout/usage.ts`. `normalizeSdk()` maps the AI SDK's camelCase `LanguageModelUsage` — `inputTokens`, `outputTokens`, `reasoningTokens`, `cachedInputTokens` — and stays separate from the existing `normalize()`, which parses the provider wire format; the two shapes share no field names. Cached input is subtracted from the SDK's inclusive input total, and a count the SDK did not report stays unknown instead of becoming zero. A recorded attempt still takes precedence, so nothing that was already exact changes.

`buildCalibration()` in `packages/harness/src/session/invoke.ts` requires the anchor's `providerID` and `modelID` to match the model being invoked, counts `reasoning` parts in the delta, and declines itself — returns `undefined`, forcing a full measurement — when the estimated delta exceeds 25% of the baseline (`CALIBRATION_MAX_DELTA_RATIO`). The ratio guard is what makes a stale anchor non-fatal rather than silently wrong: calibration is an accelerator that may only be trusted while its approximation error is small relative to the number it corrects.

`isContextExceeded()` in `packages/harness/src/session/compaction.ts` additionally matches `range of input length` and the pair `input length` + `exceeds`.

Call-level SDK usage is charged only when the call has no recorded transport attempts. A retry that failed before receiving a response remains unknown; assigning the final SDK aggregate to it would count the successful retry twice. SDK input from Anthropic, Vertex Anthropic and Bedrock excludes cache reads and writes, so their fallback retains uncached input and reported cache reads while leaving the unreported cache-write count and full input total unknown.

Google and Vertex map visible candidates to SDK `outputTokens` and thinking to `reasoningTokens`. Their fallback uses `totalTokens - inputTokens`, or sums both output components when no aggregate is available. Missing thinking and aggregate counts leave output unknown. This follows the repository-locked `@ai-sdk/google` adapter and the existing Google wire normalizer; treating this SDK as OpenAI would undercount thinking while marking the result complete.

## Alternatives considered

**Repair the transport bypass so every attempt is recorded.** This targets the cause rather than the reader and would keep attempt records the single usage source. It lost because transport recording is deliberately best-effort and `noProxy` selects a legitimate transport, not a broken one: making attempt capture mandatory would either fail runs that bypass the recording fetch or grow the transport a second mandatory path. The SDK usage was already durable on the call record, so reading it removes accounting's dependency on transport capture without weakening any recording guarantee.

**Raise the ratio threshold instead.** A larger `CALIBRATION_MAX_DELTA_RATIO` keeps the cheap path for longer, but the measured error is -26% to -51% per category: the threshold only chooses how wrong the estimate is before measurement resumes, and one high enough to never fire is the same as having no guard. The guard is calibrated to where the heuristic still corrects rather than replaces the baseline.

**Drop calibration and always measure.** This removes the failure mode with the simplest rule and no constant to tune. It lost because `PromptBudgeter.measure()` tokenizes the complete request whenever a prompt decision is needed, and the baseline exists precisely because a mismatched tokenizer — o200k_base can overestimate by roughly 2x for Claude — is worse than provider truth for the bulk of the prompt. Paying that cost on every step to avoid a bounded correction is a worse trade than measuring only when the correction has become untrustworthy.

**Gate reasoning counting behind the model's `interleaved` capability.** This is the narrower condition and it is wrong for the actual wire shape: decoding a recorded request body showed `{"type":"reasoning"}` parts serialized to the provider with no `reasoningContent`-style provider option, so reasoning reaches the prompt whether or not the model declares interleaved thinking. Gating on `capabilities.interleaved` would leave the under-count in exactly the models that emit large reasoning traces.

**Fix only the error matcher and rely on error-driven compaction.** The matcher change alone covers this provider's wording and is the smallest of the three. It lost because error-driven compaction is the last line of defense: it fires only after a doomed request has been sent and the turn has failed, and the two other defects are what let the prompt reach that point. A matcher-only fix leaves both in place for the next provider whose wording differs.

## Consequences

Provider usage survives a lost transport recording, at the cost of a second usage source. `sdkUsage` is coarser than an attempt: it carries no provider wire body, pricing basis, cache-write categories, or units, so a call recovered from it contributes tokens while its estimate follows the call-level basis. Attempt precedence keeps the exact path exact, and `attempts` versus `unobservedCalls` still reports that transport capture was missing, so the evidence gap stays visible instead of being papered over.

Calibration either rests on a same-model, same-provider baseline with reasoning counted, or it does not run at all. The cost is tokenizer work in the sessions that were previously cheapest to budget: once the delta passes 25% of the baseline, every prompt decision re-measures the complete request until a fresh provider-reported anchor is written. That direction is intended — the sessions that are growing are the ones whose prompt decision matters most — and a model switch now costs one full measurement instead of reusing an anchor that describes a different prompt.

Recognizing the input-length wording converts a fatal provider error into a compaction trigger, so a turn that previously failed now compacts and continues; the summary call can still fail when the prompt is far past the window, in which case the existing mechanical fallback and explicit failure record apply.

Coverage lives in `packages/harness/test/session/rollout-usage.test.ts` (SDK field mapping, inclusive cached input, missing counts stay unknown), `packages/harness/test/session/rollout-accounting.test.ts` (call-level usage survives a lost recording; a recorded attempt still wins), `packages/harness/test/session/invoke-calibration.test.ts` (reasoning counted, foreign anchor ignored, ratio guard declines, no anchor means no calibration), and `packages/harness/test/session/compaction.test.ts` (the input-length wording and the bare `input length` + `exceeds` pair). The calibration contract is stated in `docs/architecture/llm-loop.md`.
