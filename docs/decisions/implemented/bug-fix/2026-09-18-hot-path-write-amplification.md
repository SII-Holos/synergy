# Decision Record: Hot-Path Write Amplification

Status: implemented

## Problem

A local write-amplification audit measured an idle `sqlite-worker` at roughly 5,242 write syscalls/s and 18.76 MB/s with no user interaction, and traced part of that traffic to two hot-path defects rather than to steady-state background work.

`PartWriteBuffer.defer()` priced and protected every streamed delta by serializing the whole accumulated part (`JSON.stringify`) and deep-cloning it (`structuredClone`). Summed over one provider response that is O(n²) in the accumulated part, paid synchronously on the streaming path; recorded `llm.turn.request.bytes` p50 is 975 KB, and parts can reach megabytes. The byte accounting that drives the two buffer guards was a side effect of that full serialization.

`RolloutJournal.write()` performed two `Storage.transaction()` calls per logical write: one writing the allocated head and the journal event, then a second writing the projection and the committed head. Each call is a `BEGIN IMMEDIATE` … `COMMIT` round trip to the storage worker process, so every rollout record paid two commit round trips.

## Decision

`PartWriteBuffer.defer()` keeps a reference to the caller's live value and prices each delta from the appended text instead of re-serializing the accumulated value. `Session.updatePartInternal()` passes the streamed `delta` as that appended text, and `defer()` measures the escaped growth of appending it to a JSON string field. A first defer for a key, a defer whose value is a different object than the buffered one, or a caller that omits the appended text measures the value once, so the buffer stays correct for callers that cannot account growth. The two public guards are unchanged: 1,024 distinct keys and a 64 MiB deferred-byte budget, with the same `StorageBusyError` messages.

The exact serialization and the deep copy happen once per flush in `execute()`. The clone is what preserves the two guarantees the per-delta clone used to provide: the value written is the flush-time state, and the caller mutating the streaming object during an in-flight write cannot alter what is persisted. Re-measuring the clone also turns the deferred estimate back into an exact number, so `execute()` still rejects a snapshot that exceeds the 64 MiB budget even when the caller's incremental accounting under-reported growth.

`RolloutJournal.write()` writes the allocated sequence, the journal event, the projection record and the committed head in one `Storage.transaction()`. `RolloutPending.track(owner)` remains the first statement in that transaction, so an owner is still recorded before any journal state mutates. The invariant is that a committed head always matches the persisted event set and a projection is never visible without its evidence: a crash either exposes none of the three writes or all of them, and the head can no longer be committed against a projection that rolled back.

`recoverPending()` and `RolloutJournal.recover()` are retained. State where `allocated > committed` remains reachable from interrupted historical two-transaction writers and from migrations, so recovery still projects committed evidence without repeating the tool or provider request, and a missing reserved event still becomes an explicit gap.

## Alternatives considered

**Clone once when a key is first deferred, then replace the stored entry on later defers.** A clone taken at the first defer freezes the part at its first delta, so flushing would persist a stale prefix of the response; refreshing the clone on each subsequent delta is exactly the per-delta deep copy this change removes. Holding the caller's object and snapshotting at flush keeps the persisted value current for one clone per flush.

**Keep measuring the whole value on every defer and only drop the clone.** `JSON.stringify` of the accumulated part is the dominant per-delta cost, not the clone. Keeping it would leave the quadratic path intact for megabyte parts.

**Keep the two journal transactions and make the second cheaper.** Merging commit boundaries is the operation that removes the duplicate `BEGIN IMMEDIATE` … `COMMIT` round trip; a cheaper second transaction still pays it, and it leaves the head/projection pair unatomic.

**Keep a separate allocation transaction and merge only evidence with the projection.** The allocation-first split exists to bound the window in which a head advertises a sequence whose projection has not applied yet. Once allocation, evidence, projection and head commit as one transaction that window does not exist, so the split has no remaining purpose. Historical state in that window is still handled by recovery.

**Delete `recoverPending()` now that writes are single-transaction.** Rejected: existing homes and inline migrations can hold allocated-but-uncommitted sequences. Removing the pending path would strand their evidence after an upgrade.

## Consequences

The per-delta cost on the streaming path becomes O(delta) plus one full measurement per flush interval, and the buffer's retained state grows to reference the caller's part object rather than a private copy of it, which is bounded by the same 1,024-key and 64 MiB guards. A caller that mutates the part outside the appended text (for example provider metadata) can drift the deferred estimate; the flush re-measures exactly and continues to enforce the budget, so drift can only cause an early rejection, never an over-budget write.

Each logical rollout write emits one transaction instead of two, and the head is written once at a fully committed value instead of twice. The journal keeps its `allocated`/`committed` shape, its `recover` return value, and its historical gap semantics, so archives, snapshots and recovery consumers are unaffected.

Coverage: `packages/harness/test/session/part-write-buffer.test.ts` covers the entry cap, the deferred-byte budget, final-state persistence across incremental defers, mutation after defer and during an in-flight write, and the exact-snapshot rejection; `packages/harness/test/session/rollout-journal.test.ts` covers atomic rollback of allocation, evidence and projection, a single commit per logical write counted at the driver boundary, and recovery of historical two-phase state.
