# Decision Record: Compaction thresholds use the visible input window

Status: implemented

## Problem

Shared-context models reserved their full declared output before applying the compaction threshold. A 1,000,000-token model with 128,000 output compacted near 715,000 input tokens, not the 850,000 implied by the configured 85%. Replay measurement also disagreed with what providers bill. The final wire transform cleared interleaved reasoning that the budget had already counted. Anthropic reasoning without a signature was counted even though the SDK omits it. Encrypted OpenAI reasoning was charged at least 1,024 tokens per item even when the producer reported far less: one recorded GPT request with 109 encrypted items was billed 19,886 tokens for them (provider attribution, median 100 per item) but estimated at about 120,000, which crossed an 85% threshold at 72% actual use.

## Decision

The soft threshold is the explicit input limit, or the context, multiplied by `compaction.overflowThreshold`. Output remains a per-call clamp to the context left after measured input and the existing margin. Interleaved `reasoning_content` is idempotent across the budget and wire transforms. Anthropic reasoning is kept only when it has a signature or redacted payload, matching what the SDK can replay. Encrypted reasoning with positive producer-reported usage is charged that usage; the 1,024-token estimate applies only when usage is unknown. The threshold setting accepts 20% through 100%, and the settings scale offers 20% to 95%.

## Alternatives considered

**Lower the configured context or raise the threshold.** These change user configuration to compensate for a hidden reservation and leave reasoning measurement wrong.

**Keep a smaller fixed output reserve.** The user-visible percentage would still differ from the trigger. The per-call output clamp already prevents a request from exceeding the context.

**Drop interleaved reasoning from budgeting.** Providers that require reasoning replay with tools would receive more than the budget counts.

## Consequences

Long-context sessions compact at the configured fraction of their visible window, and long outputs near that point receive a smaller per-call output limit. Interleaved providers again receive prior reasoning after tool calls. Anthropic history without replay metadata no longer causes early compaction. Users can choose an earlier threshold down to 20%. Regressions cover the threshold formula, producer-usage charging for encrypted reasoning, the threshold bounds, output clamp, double transformation, a real local OpenAI-compatible request body and Anthropic replay eligibility. Replaying the three reported sessions' recorded requests no longer compacts any of them. They do not establish live-provider tokenizer accuracy.
