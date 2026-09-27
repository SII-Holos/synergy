# A started runtime stranded saved input

## Executive summary

Startup and navigation fixes did not establish that the first saved message could progress through storage admission, canonical materialization and execution. A namespace-wide cleanup query blocked the writer on a large database; reader and writer connections shared an event loop; the frontend's timer then presented a saved input as failed. Isolated upgrade tests exposed two additional recovery defects: a new input could inherit execution ownership from an obsolete root, and retry did not release an interrupted session's pause. The missing guardrail was behavioral coverage across these boundaries at realistic scale.

## Summary

The reported new message entered durable storage quickly, but canonical materialization waited behind a long writer hold. Model execution itself was short. Existing fixes for optional format maintenance, deferred reclamation, startup progress and historical navigation addressed their respective paths; none bounded the unrelated cleanup performed while creating the next message. A visible conversation list was therefore insufficient evidence of a usable upgraded runtime.

## Timeline

- On 2026-09-22, an updated managed Desktop displayed historical conversations but showed initialization failure after accepting a new message.
- Runtime and storage evidence separated durable acceptance, writer occupation and model execution.
- Indexed-query and subtree fixtures reproduced namespace-wide cleanup and premature physical prune completion.
- The isolated historical writer fixture reproduced obsolete-model execution before new input materialization, then a retry that remained blocked by the pause latch.
- Managed Desktop multi-turn acceptance found a separate frontend aliasing defect: advancing context usage mutated the previous transcript reply's identity. Reload restored the persisted reply, masking the live-view failure.
- Regression tests covered the failures before implementation changes; local acceptance exercised real models, historical data, independent readers and repeated restarts.

## Root cause

Cleanup's anchor predicate let SQLite drive the query by namespace. Even a missing key could inspect unrelated nodes. Physical pruning bounded a recursive node result and interpreted the deleted record count as exhaustion; intermediate nodes and a fixed cleanup-round limit left records or ancestors behind. The queue's deadline check ran only when dispatch finally reached the waiter. Two connections provided database isolation but shared one synchronous execution loop.

The UI inferred backend failure from elapsed time. Its retry action rearmed an Inbox item without clearing the session's authoritative pause. The execution loop resolved an old root's configuration before consuming new queued work, so an unavailable old model or terminal Rollout could poison a valid task behind it.

The context-usage projection also shared message objects with the conversation window. Reconciliation at an object root updated that object even when the incoming message had a different ID. Advancing usage therefore rewrote the previous visible assistant into the next one; a later message-window reconciliation discarded the duplicate. Persisted data remained intact. The fix replaces the pointer on identity changes and retains in-place reconciliation for same-message updates.

Existing narrow tests established startup, navigation and small-store correctness independently. They did not require a saved input to become canonical and complete against a large historical store, nor retry the same saved input after restart. Successful slow SQL was sampled sparsely, making a blocking successful operation harder to distinguish from model or network failure.

## Guardrails added

- [Subtree cleanup](../../packages/harness/test/storage/subtree-cleanup.test.ts) verifies addressed query plans and complete wide/deep deletion in both supported key formats.
- [Admission](../../packages/harness/test/storage/queue-admission.test.ts) verifies pending deadlines, inherited cancellation, foreground ordering and caller context.
- [Reader isolation](../../packages/harness/test/storage/reader-worker-isolation.test.ts) suspends an owned writer and verifies independent reads, snapshots and reader replacement.
- [Historical execution](../../packages/presets/test/runtime/queued-input-upgrade.test.ts) exercises new input behind historical, failed and cancelled roots with a real protocol fixture.
- [Input status](../../packages/harness/test/session/input-status.test.ts), [retry](../../packages/server/test/server/session-input-worktree.test.ts), and [frontend observation](../../apps/web/test/components/session/session-input-observer.test.ts) cover durable recovery and late responses without timer-inferred failure.
- [Maintenance admission](../../packages/server/test/server/maintenance-admission.test.ts) checks active work and already-admitted mutations before storage shutdown.
- [Context projection](../../apps/web/test/context/global-sync-context-projection.dom.test.ts) verifies retained transcript identity across consecutive replies, metadata enrichment, snapshot changes and history-mode arrivals. Managed Desktop additionally checks every earlier reply before reload.

Performance thresholds remain local acceptance criteria. CI enforces the behavioral invariants and supported backend contracts rather than machine-specific latency.

## Lessons

Startup success, historical visibility, durable admission, canonical publication and model completion are distinct observations. Verify each on the same upgraded fixture and preserve failed attempts. A recovery button must clear every authoritative gate preventing its saved work from progressing. More connections do not provide event-loop isolation, and bounded row counts do not establish bounded tree work.
