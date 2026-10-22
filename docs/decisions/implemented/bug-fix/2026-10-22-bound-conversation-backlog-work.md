# Decision Record: Bound conversation backlog work

Status: implemented

## Problem

Returning to a busy Session could dispatch every mounted Part body at once. The version cache shared duplicate reads, but separate bodies had no admission bound. Its adapter retained only the Scope signal, so leaving a viewport did not cancel obsolete body downloads. Streaming Chinese punctuation also split one snapshot into thousands of adjacent DOM writes despite all text belonging to one paragraph. A large live paragraph bypassed terminal virtualization and made browser layout block for seconds even when its compressed transfer was small.

Ordinary events also created full Scope state for projects the user had never opened, dispatching unrelated bootstrap and panel reads merely to maintain global status and request indexes.

Returning to a completed background reply could retain its footer while the preceding pending answer unmounted. That released the body lease and prematurely admitted motion. Warm user messages also remounted as plain text while Markdown parsed again. Their height shrank and expanded within deferred measurement delivery, producing stale scroll compensation and visible position jumps.

## Decision

The existing Part content store owns a four-transport FIFO admission bound after version deduplication. Queued cancellation removes the read before dispatch. Consumers combine the materializer lease and Scope lifetime through [AbortSignal.any](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal/any_static); only the last consumer cancels shared transport. Cancellation prevents cache publication even if a transport finishes late.

The existing [streaming-markdown renderer](https://github.com/thetarnav/streaming-markdown) batches adjacent text callbacks for the same element and merges contiguous source spans. Token and attribute boundaries, a 32 KiB buffer target and the end of an update flush the batch. Existing text nodes, grapheme continuity, selection and source mapping remain authoritative. This uses the existing incremental renderer and adds no parser or query dependency.

Live text above 262,144 UTF-16 code units uses the existing Markdown worker and [Virtua](https://github.com/inokawa/virtua) blocks. The first large snapshot starts immediately; later snapshots admit one parse at a time and coalesce the latest text over 250 ms between parses. Publication preserves the mounted virtualizer, defers while text is selected or a descendant is focused, and rejects a result that is no longer a prefix of the current source. Ending or changing the source owner bypasses the live cadence. Normal-sized streams retain their incremental parser. The handoff measures only blocks fully covered by the rendered source prefix; Virtua accepts those prefix measurements and leaves the unseen suffix unmeasured. This prevents unseen blocks from inheriting the last visible text position and receiving false one-pixel heights. Both Solid entrypoints preserve this contract. After Virtua commits the source reading point, a bubbling `content-layout-restored` event transfers the accepted geometry to the outer reading viewport. Only its current anchor owner can refresh that anchor; following mode remains owned by normal bottom pinning.

Global status, Cortex and pending-request events update their existing global indexes before consulting Scope-local state. Ordinary events never create an unviewed Scope. A real sequence gap, epoch change or projection reset explicitly admits the existing replay/bootstrap recovery; it does not silently lose missed permissions or status changes. Opening a Scope retains the normal snapshot and event freshness gates.

During resumed latest-following hydration the outer virtualizer retains the latest answer body alongside its terminal row. This keeps its pending lease authoritative until the body settles without retaining earlier history. User Markdown reuses the existing byte-budgeted LRU for completed sanitized HTML, scoped weakly to the parser owner with a 4 MiB cap. Full source and reference ranges identify the render; cache hits return synchronously, and cancelled work cannot publish. This removes repeated parsing and plain-text geometry on warm virtual remounts without extending the virtualizer or changing measurement scheduling. History reading, inner process reading and explicit location anchors retain their existing ownership.

## Alternatives considered

**Rely on the cache or browser connection limit.** Cached versions do not bound simultaneous misses, and a Scope lifetime outlives the visible reader. Neither removes obsolete queued work.

**Replace a paragraph's text content in one assignment.** That reduces calls but replaces accepted text nodes and breaks reading and selection ownership. Appending batches preserves those identities.

**Parse every live snapshot or mount its entire DOM.** The former repeats full-source work per transport chunk; the latter leaves layout unbounded even with fast parsing. Coalesced worker snapshots share the existing full-fidelity virtual renderer.

## Consequences

Returning views share bounded request capacity; background consumers can no longer keep abandoned downloads alive merely because their Scope survives. Complete Part bodies still transfer in full: the concurrency limit and prefetch budget are not a per-response byte limit. The small regressions assert dispatch counts, cancellation, late publication and DOM mutation bounds instead of platform-specific timings or large datasets.

Production history acceptance releases its body-delivery gate on either HTTP or an authoritative WebSocket checkpoint. A checkpoint may satisfy the current body before its queued HTTP read dispatches; waiting for that cancelled request would deadlock the test. Readiness, complete text and stable geometry assertions remain unchanged.

Background-return stress applies its 20× CPU throttle after initial hydration and uses the shared isolated-test deadline. CI can exceed a shorter wall-clock override under artificial slowdown; the fixed frame samples still require readable rows, stable following and no hidden body reads throughout the transition.
