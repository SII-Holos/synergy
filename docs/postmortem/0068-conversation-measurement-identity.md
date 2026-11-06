# Conversation measurements lost row identity

## Executive summary

Collapsing a process could move the conversation down and immediately back up. The surviving answer kept its DOM identity but inherited a removed row's cached size. Settled-layout and short-answer checks missed the invalid intermediate geometry. Structural list changes must preserve measurement identity before publishing a new scroll range.

## Summary

Removing process rows from the middle of a long conversation temporarily reduced the virtual container height. Native scroll clamping moved earlier content, then remeasurement and reading restoration moved it back. This happened without a parent transform or replacement of the answer node.

## Timeline

- 2026-10-12: Frame-level analysis identified the discrepancy between an answer's actual height and its virtual size after process removal.
- 2026-10-12: A browser regression reproduced a `2034.75px` answer retaining only `8px` of cached height through both shipped Solid entrypoints.
- 2026-10-12: Transferring measurements by stable key preserved that height through deletion, insertion and reordering, with existing prepend compensation retained.

## Root cause

The app's keyed row list removes exiting process rows after disclosure finishes. Virtua's default length update truncates cached sizes at the end; it cannot identify which middle rows disappeared. Solid retains the answer DOM by key, while the size cache associates its new index with a different row. Resize delivery later repairs the mismatch, but the browser can clamp `scrollTop` against the provisional, much shorter scroll range first. Reading restoration repairs the resulting displacement only after that invalid range has been exposed.

## Guardrails added

- [Measurement tests](../../apps/web/test/components/session/conversation-process-virtualization.dom.test.ts) assert retained row sizes immediately after middle edits through both Solid entrypoints, then check subsequent frames and prepend.
- [Disclosure tests](../../apps/web/test/components/session/conversation-process-disclosure.dom.test.ts) exercise repeated expansion and collapse beside a long answer, measuring reading position and continuous DOM identity.
- The [decision](../decisions/implemented/bug-fix/2026-10-12-keyed-conversation-measurements.md) and [frontend workflow](../../.synergy/skill/develop-frontend/references/conversation.md) require measurement identity and intermediate-frame checks.

## Lessons

DOM identity and measurement identity are separate guarantees. A final restored position cannot prove that no visible intermediate jump occurred. Test long retained rows next to small disappearing rows, including equal-length edits and both dependency entrypoints.
