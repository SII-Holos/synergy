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

## Lessons

A native scroll event does not establish fresh reading intent. Test changed header geometry, asynchronous row sizes and repeated event delivery together; a correct settled offset alone misses the failure.
