# Decision Record: Publish rollback invalidation before the replacement root message

Status: implemented

## Problem

After a rewind, the frontend hides everything at or after the rollback cut point while `canUnrollback` is true (prefix-cut semantics in `messagesHiddenByRollback`), and degrades to hiding only the dropped set once the replacement branch is visible. `Session.updateMessage` wrote the replacement root, published its `message.updated`, and only then flipped the persisted rollback projection. The replacement root therefore reached the frontend while the session record still claimed `canUnrollback: true`, so the new branch — including the latest assistant reply — was prefix-hidden in the view while its tool cards, delivered through unsequenced streaming events, still rendered. A refresh or session switch re-fetched the authoritative page and healed the view, which matches the reported symptom (last assistant reply disappears after a rewind, tools remain visible, refresh restores it).

The projection flip itself shipped in an earlier fix (`a843a91c8`); this change closes the ordering gap it left between the flip's `session.updated` and the root's `message.updated`.

## Decision

`Session.updateMessage` now awaits `publishRollbackInvalidation` before publishing `MessageV2.Event.Updated` for the written message. The flip's `session.updated` (carrying `canUnrollback: false`) is therefore sequenced before the replacement root's `message.updated` in the same write path, so the frontend can never prefix-hide the new branch behind a stale projection. The invalidation remains idempotent: it only acts for root user messages written after the rollback, publishes the flip at most once per session, and is a no-op when no rollback is active or redo is already unavailable.

## Alternatives considered

**Frontend-only healing** — keep the server order and, in the `message.updated` handler, force a session sync when a post-cut root arrives while `canUnrollback` is true. Rejected as the primary fix: it still leaves a window where the prefix-cut hides the branch between the two events, and it treats a symptom in the renderer when the server owns the causal order of its own publishes. The server-side reorder removes the bad ordering at its source.

**Synchronous re-derivation in `updateMessage`** — recompute the full rollback projection (`SessionHistory.storedInfo`) inside the message write path instead of reordering the existing flip. Rejected: the existing flip path was already deliberately written to avoid history-wide scans on the hot message-write path, and reordering preserves that property.

## Consequences

The replacement branch's root message is published only after its redo invalidation is durable and published, so the frontend never receives the new branch under a stale `canUnrollback: true` projection from this path. The invalidation work (one session-info read-modify-write plus one `session.updated` publish) now sits on the critical path of the first post-rollback root write instead of trailing it, which is a negligible cost for a rare, once-per-session transition. A regression test in `packages/synergy/test/session/rollback.test.ts` asserts the publish order through the bus.
