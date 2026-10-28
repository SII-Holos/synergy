# History pagination replaced the reading anchor

## Executive summary

Loading earlier messages could displace the visible conversation despite valid keyed measurements. Automatic scroll delivery replaced the reader's saved anchor before resize restoration; duplicate receipts could then select a newly inserted row. Existing prepend checks mostly observed settled layouts without removing the history header. Reading intent must survive intermediate layout events as well as the final position.

## Summary

Frame sampling reproduced a 60px upward displacement when a 40px load-earlier control and its 20px gap disappeared during a prepend. Correcting only the first receipt still allowed a later 54px displacement when a newly visible historical row became the anchor and finished measuring.

## Timeline

- 2026-10-12: A recording exposed large movement when loading earlier conversation history.
- 2026-10-12: A real-row browser fixture isolated header removal and scroll-before-resize ordering after the keyed measurement correction.
- 2026-10-12: Preserving the accepted owner across extent changes and unchanged-offset receipts kept the existing message at its original frame position.

## Root cause

Virtual prepend compensation writes the outer scroll offset. Its native event can arrive before the content ResizeObserver restores the reading anchor. Treating every unmatched receipt as reading movement captures the already displaced position. Even after restoring that first receipt, a second event at the same offset can choose an incoming historical row now visible in the space vacated by the header. Later body measurement then follows that new owner and moves the originally visible message.

The inline return-to-latest button also occupied the history header. Removing it requires preserving the floating action when the canonical window omits latest messages, even if its currently loaded content has no remaining scroll distance.

## Guardrails added

- [Browser reading tests](../../apps/web/test/components/session/conversation-process-reading.dom.test.ts) click the load-earlier control and assert the retained message position at every frame.
- [Scroll-owner tests](../../packages/ui/test/hooks/create-auto-scroll.test.ts) cover both resize ordering and explicit native movement.
- [Conversation control tests](../../apps/web/test/components/session/conversation-row-retention.test.ts) cover unloaded latest content and keyboard return.
- The [decision](../decisions/implemented/bug-fix/2026-10-12-history-pagination-reading-continuity.md) and [frontend workflow](../../.synergy/skill/develop-frontend/references/conversation.md) capture the ownership and regression requirements.

## Follow-up evidence

A later production case paged inside one long turn: assistant headers appeared before their summaries and inserted temporary load rows ahead of the final answer. The retained answer was virtualized out and remounted even though no body request repeated. Bounded summary preparation before page admission and a 240-continuation production regression address this separate trigger; see [history and tool arrival continuity](../decisions/implemented/bug-fix/2026-10-12-history-and-tool-arrival-continuity.md).

On 2026-10-27, investigation of a long-reply/prepend CI failure exposed the inverse ordering: resize restoration acknowledged the new extent, then a later compensation write changed the offset. The scroll handler saw no remaining extent change and captured the displaced position as new reading. Extending the existing hook regression to perform that write after resize deterministically retained 800px instead of the accepted 740px. Leaving extent acknowledgment to the scroll receipt fixes that case while both native-input orderings remain authoritative. The original browser failure had no event trace; this deterministic defect does not establish that every observed browser timing failure has the same cause.

The same investigation separately captured `ResizeObserver loop completed with undelivered notifications.` during initial reading-owner acquisition, before history prepend. The owner signal reran an effect that unobserved and re-observed the unchanged content and viewport ancestors during resize delivery. A minimal real-browser content-rebinding regression reproduced that window error. Incremental observation membership fixes it without deferring restoration or suppressing errors. A same-input comparison with the old extent-acknowledgment behavior also reproduced the notification error, distinguishing these two defects.

A separate nested-process test sampled 277px of target movement while its viewport stayed fixed. Its setup emitted one reading gesture, waited a fixed delay, then moved to another Part without new input while layout restoration was still pending. The accepted anchor remained Part 396 while the test measured Part 400. Emitting the intended movement at alignment captured Part 400 and retained it through evidence growth. The test now waits for its actual scroll receipt, checks target alignment, and keeps its original connectivity, per-frame drift and overlap limits. No inner viewport implementation change was needed for that preparation defect.

Independent review of the unpublished extent fix found a continuous-input regression: the first accepted movement cleared its input marker, so tail resize followed by another movement in the same gesture restored 240px instead of accepting 280px. Four input forms reproduced it; the old extent behavior accepted 280px but still lost a later compensation after the gesture ended. Retaining the movement offset until native `scrollend` preserves both requirements. This was a correction to the candidate fix, not attribution of the original CI failure.

Joint validation then exposed the same lifetime error in the separate inner process owner. Native Space followed by real evidence growth could retain only its first movement: the trace showed virtual compensation followed by an old-anchor restoration. A standalone component fixture, without the outer hook, deterministically accepted only 40px of two 40px movements. That inner implementation matched the initial PR head and inspected base. Retaining its existing movement marker until `scrollend` lets each receipt cancel stale layout restoration and capture the new position. Space and PageDown regressions also require reading stability after completion; the real native-input check keeps its original >100px assertion. This is independent of the earlier test-preparation defect and does not identify the original prepend CI event sequence.

## Lessons

A native scroll event does not establish fresh reading intent. Test changed header geometry, asynchronous row sizes and repeated event delivery together; a correct settled offset alone misses the failure.
