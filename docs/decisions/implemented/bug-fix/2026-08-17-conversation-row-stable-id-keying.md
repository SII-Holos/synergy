# Decision Record: Key conversation rows by stable message id

Status: implemented

## Problem

Long-running sessions crashed the renderer with V8 JavaScript OOM (4 GiB heap limit) after ~33 hours. Heap snapshots of the renderer showed ~190 detached `SessionTurn` trees accumulating in 75 minutes, with the same message id rendered 5–10 times as abandoned rows. Each abandoned row kept its Solid owner graph (contexts, computations, DOM listeners) alive after its DOM was detached.

The conversation list rendered rows with Solid's reference-keyed `<For each={props.timeline()}>`. The message window store is updated through `reconcile(..., { key: "id" })`, which preserves the array proxy but **replaces every element proxy** on each sync (verified empirically against solid-js 1.9.10: `element proxy preserved: false`). Rollback projections additionally produce new arrays via `slice`/`filter`. Every message-window sync therefore destroyed and recreated every row, and abandoned rows stayed alive in the Solid owner graph.

## Decision

Key conversation rows by the stable message id instead of by message object reference:

- New helper `buildConversationTimelineSnapshot()` (`packages/app/src/components/session/conversation-timeline.ts`) builds `{ keys, map }` from the timeline, keyed by `message.id`.
- `conversation.tsx` renders `<For each={timelineSnapshot().keys}>` and reads the current message object through a snapshot getter (`timelineSnapshot().map.get(key)`), so object replacement propagates updated data without remounting the row.
- The assistant variant switch uses `Dynamic` instead of per-render component selection so it stays reactive inside the stable row.
- Regression coverage: `conversation-timeline.test.ts` (helper) and `conversation-row-retention.test.ts` (behavioral Playwright fixture mounting `SessionConversation`, replacing message objects with same ids, asserting the row owner stays mounted while updated text propagates).

## Alternatives considered

- **Keep reference-keyed `<For>` and only fix dispose paths downstream** — rejected as the primary fix: every `message.updated` sync replaces element proxies, so the rows are destroyed and recreated regardless of downstream cleanup; reducing remounts removes the dominant churn the heap snapshot attributed to the leak.
- **`<Key by={message.id}>` from solid-js** — rejected: `Key` maps over the array by key but still re-reads values through the same reference semantics; a stable snapshot map with per-row getters keeps updated data flowing through existing rows with explicit semantics matching the existing `timelineItemSnapshot` pattern in `session-turn.tsx`.

## Consequences

Message window updates no longer remount the full conversation; rows are reused across object replacement, which removes the dominant detached-owner accumulation. Data still propagates through per-row getters. The dispose-gap behind why abandoned trees stay GC-reachable (listeners/observers registered outside the component owner) remains a separate follow-up; this change stops the primary driver identified by heap evidence.
