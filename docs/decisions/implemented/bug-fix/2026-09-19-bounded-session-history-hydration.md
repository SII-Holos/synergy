# Decision Record: Bound session history part hydration by the declared concurrency window

Status: implemented

## Problem

A session that had grown to roughly 1,200 messages could no longer complete a turn. Every new input failed before any provider call with `StorageBusyError: Authoritative storage queue is full`, and repeated inputs reproduced the same failure identically until the session was abandoned.

`StorageQueue.run` rejects when `pending >= 1024` rather than waiting for a slot (`packages/harness/src/storage/queue.ts:10`). The SQLite driver owns one `writerQueue` and one `readerQueue` for the whole process (`packages/harness/src/storage/sqlite-driver.ts:52-53`), so that bound is shared across every session on the runtime instead of being per session.

`SessionHistory.loadModelMessages` hydrated its selected messages with a bare `Promise.all` over the selected set (`packages/harness/src/session/history.ts:391`), so its read fan-out was exactly proportional to message count. The same file already declared and applied a bounded window to its two neighbouring hydration paths — `PAGE_HYDRATION_CONCURRENCY = 16` (`history.ts:20`) used by `messagePage` (`history.ts:452`) and by `deriveInfoSemantics` (`history.ts:550`) — but not to the model-message load.

The message count that matters is the pre-compaction one. `modelWorkingSetProjection` only narrows the selected set once a committed compaction boundary exists; before one is committed it yields no projection and `selected` is the complete effective history. A session that is approaching its compaction threshold is therefore precisely the session that fans out one reader per message, and at roughly 1,200 messages that fan-out exceeded the 1,024-slot reader queue on its own.

The failure is self-reinforcing. Compaction is a blocking pre-phase loop job (`packages/harness/src/session/compaction.ts:977-981`), and it loads history through `detachedModelMessages` (`compaction.ts:1014`), a path that deliberately bypasses the message cache (`history.ts:344-350`). Each new input triggers compaction, compaction loads the full history, that load trips the queue, and the turn fails before a provider call is made. Retrying replays the same sequence, and because the turn never reached the model there is no partial progress to resume from: the session settles idle with `pendingReply: true` and cannot recover on its own.

Observability confirms the failing surface is the read path rather than the store itself: of the recorded `storage.operation.error` entries, 3,508 were `read`, 388 were `readMany`, one was `scan`, and one was `list`, while `write`, `update`, and `remove` recorded none. The datastore was healthy; the read queue was saturated.

## Decision

The model-message hydration now uses the bounded window the rest of the file already uses. `loadModelMessages` replaces its `Promise.all(selected.map(...))` with `mapWithConcurrency(selected, PAGE_HYDRATION_CONCURRENCY, ...)` (`history.ts:391`), and the constant keeps its existing value of 16 and its existing meaning.

This covers both callers. `modelMessages` and `detachedModelMessages` share `loadModelMessages`, so the loop path, compaction, title generation, summarization, and continuation recovery all inherit the bound. No selection, ordering, caching, signal, or derivation semantics change: `mapWithConcurrency` preserves input order in its result array, and every `loadParts` call and `throwIfAborted` check runs exactly as before, only with at most 16 outstanding at a time.

The bounded window is the existing, already-reviewed value for hydrating message parts in this file rather than a new constant, so pagination, legacy derivation, and full-history loading now share one hydration budget.

## Alternatives considered

**Make `StorageQueue` wait for a slot instead of rejecting.** This would remove the visible error but replaces a bounded, observable rejection with unbounded latent queueing. Every caller of the shared writer and reader queues would inherit the new wait semantics, and the driver's separate admission-deadline rejection (`queue.ts:18`) exists precisely because an unbounded wait is the outcome that deadlocks. The reject-fast contract belongs to the queue owner; the defect is an unbounded caller.

**Raise the 1,024 bound.** The fan-out is proportional to session length, so any constant is a message count at which the same failure returns. Raising it also increases the number of in-flight reads and their buffered bytes with no new guarantee.

**Hydrate only the compaction working set in the loop.** This is what the projection already does once a boundary is committed, and it does not apply to the failing case: before compaction commits there is no working set, so the complete effective history _is_ the selected set. The generic transcript path is also required to stay complete for export, rollback, fork, and UI consumers.

**Give history loading its own queue or a per-session queue.** Adding a second concurrency controller beside the driver's own queues violates the single-owner boundary and would need its own admission policy, deadline, and close semantics. The unbounded fan-out is the caller's defect and is removed at the caller.

**Serialize hydration to a single outstanding read.** Correct but needlessly slow for large transcripts; the file's existing window already encodes the reviewed trade-off for this exact work.

## Consequences

A session's history load no longer scales its concurrency with message count, so a session can exceed the reader-queue depth without starving its own turns or any other session's reads on the same runtime. The self-reinforcing compaction loop is broken at its cause, because the load that triggered it is now bounded.

The cost is wall-clock: hydrating a very large transcript is now limited to 16 concurrent part loads instead of issuing every load at once. For a roughly 1,200-message session that is on the order of 75 sequential rounds of 16 rather than a single round, which is a small multiple of the per-round IPC cost and is not on an interactive path. Pagination and legacy derivation already accepted the same bound for the same work.

Two related properties are deliberately left unchanged and remain owned elsewhere. `StorageQueue` still rejects rather than backpressures, which is what makes the bound observable at all; and compaction remains a blocking pre-phase job, so if a history load fails for any other reason the turn still fails before the provider call and still requires a new input rather than resuming in place.

`packages/harness/test/session/history-load-concurrency.test.ts` asserts the invariant directly: with 48 messages and a spy on part loading, every message is loaded exactly once and the peak number of concurrent loads never exceeds the declared window. Against the previous implementation the same test reports a peak of 48 — one load per message — and fails.
