# Decision Record: Recover inbox tasks after explicit abort and prune ghost inbox rows client-side

Status: implemented

## Problem

Two user-visible defects shared one trigger: a message queued while a run was active, followed by an explicit abort.

1. **Stranded durable task.** The loop's post-turn abort path deliberately keeps `task` inbox items (`removeByMode(["steer", "context"])` only). But two later changes removed every path that would wake the session to consume them: terminal assistant errors became a thrown `SessionTerminalError` (`7c6ad5619`), and `loop()`'s failed exit suppressed the release-time pending-work drive (`4a97fb40d`, `requestNextWorkOnFailure: false`). An abort is a loop failure, so after abort nothing drove the surviving task — it stranded in the inbox until the next user message arrived, at which point both messages materialized together. Production data confirmed stranding (channel task items days old in active scopes).
2. **Ghost inbox row.** Backend inbox consumption is peek-then-commit and always deletes the item on disk (forensic scan: zero materialized-but-undeleted items). But the client applies a queued `session.input()` acceptance by upserting the returned item into the store, guarded only by inbox-resource freshness. When the backend consumed the item before the HTTP response landed (idle transition, delayed event, reconnect gap), the upsert resurrected a row that the missed `session.inbox.updated` would have cleared, and badge/popover surfaces render the raw bucket.

## Decision

- `SessionManager.run()`'s release path now captures `lease.signal.aborted` **before** `finish()` (release aborts the controller, which would erase the distinction) and treats an explicit abort like a completed run for the pending-work drive: `requestNextWork: completed || explicitlyAborted || requestNextWorkOnFailure !== false`. Abort is a user action, so this restores one-shot recovery for queued tasks without reopening the failed-loop hammering that `4a97fb40d` suppressed for ordinary errors.
- The client treats a canonical materialized user message as proof of inbox consumption. `removeMaterializedInboxItems` prunes the matching item (by pre-allocated `messageID`) from the store bucket when a user `message.updated` lands; `isInboxItemMaterialized` guards the acceptance-response upsert, skipping insertion when the item's message is already in the loaded window as a non-optimistic message.

## Alternatives considered

- **Drive the recovery from `SessionAbort.abort()` instead of release** — rejected: abort signals while the owner is still `stopping`; driving there would arbitrate against a running session and race the loop's own exit. Release is the single point where the lease is gone and the drive is safe.
- **Remove `requestNextWorkOnFailure: false` from `loop()`** — rejected: it restores the failed-wake hammering for every terminal error (provider failures, context overflow), which `4a97fb40d` deliberately stopped. Only explicit aborts deserve the drive.
- **Emit a duplicate-delivery key for user inbox enqueue** — rejected: the backend never duplicates; the defect is client store state. A delivery key would add dedup machinery to every user message without healing already-stale stores.
- **Filter ghosts at render time only (badge/popover projection)** — rejected as the sole fix: it hides the symptom while the store keeps drifting; the event-side prune heals state and also fixes every other consumer of the bucket.

## Consequences

Aborting a run now consumes the durable task queued during it via the normal release-driven arbitration, preserving abort semantics (steer/context still discarded, no auto-start of a _new_ loop beyond the drive decision). The client self-heals ghost inbox rows on the next user `message.updated` for that message and no longer inserts them from late acceptance responses; already-stale stores heal when any of the item's messages re-appears or the bucket refreshes. The abort-capture must stay before `finish()` — reading `lease.signal.aborted` after release would always be true and re-open the hammering. The ghost prune depends on the message window being event-reachable; an evicted-window session heals on its next bucket refresh instead.
