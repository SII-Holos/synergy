# New-row following rebound

## Executive summary

A streamed row could move the conversation sharply upward and then back down. Deferred virtual measurement exposed a historical median estimate to automatic following before the actual short row was measured. Tests that checked final scrolling and disclosure separately missed their interaction. Admission geometry and every painted frame need coverage together.

## Summary

A browser fixture with 212 px historical rows appended a 33 px row using the real disclosure and automatic-follow hooks. The preceding row moved from 396 px to 184 px, returned to 396 px, then settled at 363 px. Both shipped Solid entrypoints reproduced the same rebound. A plain append without disclosure motion did not reproduce it.

## Timeline

- Integration review of conversation continuity fixes identified the earlier streaming-bounce report as unresolved.
- A composed browser regression failed through both dependency entrypoints.
- Batched initial admission measurements eliminated the overshoot and reversal in the same regression.

## Root cause

New virtual rows had no accepted size. Their estimated height changed the parent scroll range, so following moved toward an incorrect tail. Disclosure preparation then started the row at zero while ResizeObserver delivery was queued to another frame. Correction of the estimate invalidated the first scroll target. Keyed retained measurements did not cover new identities; final-position tests accepted the rebound because it eventually converged.

## Guardrails added

- [Per-frame browser regression](../../apps/web/test/components/session/conversation-process-virtualization.dom.test.ts) through JavaScript and JSX entrypoints with real motion owners.
- [Initial-admission decision](../decisions/implemented/bug-fix/2026-10-12-measure-new-rows-before-following.md) limits synchronous work to newly mounted unmeasured rows.
- [Conversation development guidance](../../.synergy/skill/develop-frontend/references/conversation.md) requires composed motion and per-frame assertions.

## Follow-up evidence

A later live-provider case exposed another overlap: a tool disclosure began while the parent still carried a following offset. Excluding all disclosure compensation cancelled that offset immediately. Retargeting from the painted offset while retaining the original deadline prevents both cancellation jumps and indefinitely extended settling. The [follow-up decision](../decisions/implemented/bug-fix/2026-10-12-history-and-tool-arrival-continuity.md) adds a composed browser test with the presentation clock held while real child layout changes.

## Lessons

Correct DOM identity and final scroll position are necessary but insufficient. The geometry exposed to another animation owner before the next paint is observable behavior and needs its own regression.
