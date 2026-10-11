# Streamed usage recovery

## Executive summary

Valid GPT streams with missing response media types were archived but parsed as JSON, leaving usage and content timing unknown. The live checkpoint then made historical rebuild skip the affected records, while a retained incomplete estimate prevented cost recovery even after parsing. Existing regressions covered correctly labeled streams but not this combination. Response evidence, derived statistics and repair progress need separate validation.

## Summary

Fourteen retained GPT conversation requests reproduced the missing usage. Their original SSE responses contained input, cache and output counters. A temporary database independently reproduced skipped recovery after the live checkpoint reached the head, and a saved estimate with a null total surviving token recovery. The cache formula itself was not the cause.

## Timeline

On 2026-10-09, isolated GPT and DeepSeek requests exposed a discrepancy between raw responses and retained usage. Ninety-four existing relevant tests passed. New parser, timing and historical fixtures reproduced the gaps before implementation. Subsequent task-summary verification also reproduced stale cached values after a successful background repair.

## Root cause

Response framing was selected solely from the media type. The same assumption controlled transport content observations. Historical rebuild reused the incremental live checkpoint, so a successfully archived but incompletely parsed attempt looked fully processed. Cost recovery assigned an estimate only when no object existed, preserving an object whose total was unknown. Replay equality compared object serialization order and could advance the usage revision for unchanged facts. Background capture suppressed update notifications, leaving an already loaded task summary stale.

## Correction

The [implemented decision](../decisions/implemented/bug-fix/2026-10-09-usage-response-recovery.md) records bounded framing detection, independent background replay and original-price recovery. Repaired facts publish the existing usage event. Parsing never rewrites raw bytes or terminal execution records, and it does not infer historical transport timing.

## Verification

Regressions cover absent and incorrect media types, byte-sized chunks, SSE newline variants, oversized-event recovery, malformed and partial responses, old checkpoints and estimates, physical retries, repeated replay, cleared records, pruned artifacts, migration scheduling, restart with concurrent capture, and already loaded task summaries. Real GPT and DeepSeek requests compare raw provider counters, retained ledger facts and task-detail summaries. Fourteen historical GPT requests recover their token and price evidence while retaining their original unknown content timing.

## Guardrails

The [testing guide](../../.synergy/skill/testing-guide/SKILL.md) requires body framing to vary independently of headers, and historical recovery tests to start from advanced checkpoints and incomplete estimates. The [usage architecture](../architecture/usage-accounting.md) owns repair semantics. Model responses and private runtime evidence remain outside tracked documentation.
