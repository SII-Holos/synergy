# Decision Record: Serialize terminal tool settlement behind per-call state writes

Status: implemented

## Problem

A late Bash output/metadata update could overwrite an already-settled tool part with `status: running`, removing its terminal output and end timestamp (issue #1335). Bash's `flushMetadata()` calls asynchronous `ctx.metadata(...)` without awaiting it, and `finishClose()` can flush final output immediately before resolving child completion. The processor's `settleToolPart()` wrote a full terminal part replacement through `Session.updatePart()` without coordinating with the per-call `toolCallStateUpdates` queue that serializes metadata flushes. Persistence (`updatePartInternal`) performs asynchronous work before the durable write, so a running-state flush that had already started could commit after the terminal settlement. Cleanup paths skip call IDs in `settledToolCalls`, so the persisted regression was never repaired; observability recorded a successful settlement while durable session state stayed `running`. Sampled child sessions showed 18 and 38 such regressed Bash parts with no terminal counterparts.

## Decision

Terminal settlement now shares the per-call write serialization that metadata flushes already use. `settleToolPart()` registers its terminal write as the next entry on the same `toolCallStateUpdates` queue chain for the call: it waits behind queued and in-flight running-state flushes, commits the terminal state durably, and only then lets flushes queued mid-settlement run. When the durable terminal write lands, the in-memory tool part object is moved to its terminal state in place, so every guard downstream (`flushToolCallState`'s running-status check, the stream `shouldIgnoreSettledStreamEvent` filter, and the `settledToolCalls` set) observes the settled status and stops stale writers. Two adjacent bypasses were aligned with the same contract: the unresolved-parts cleanup path now settles through `settleToolPart()` instead of issuing its own full-part error write, and `markAutoExpanded()` skips its late metadata write once the call is settled.

The producer side is intentionally untouched. Bash still fires its final `ctx.metadata(...)` without awaiting it; the processor now owns the ordering guarantee, because lifecycle correctness belongs to the layer that owns settlement.

## Alternatives considered

**Await the final Bash metadata update in `finishClose()`.** Not taken: it narrows one producer's window but leaves the invariant unowned — any tool or future code path that emits `ctx.metadata` late reintroduces the race, and the processor would still happily write terminal state behind an in-flight stale write.

**Guard in `flushToolCallState()` by re-reading durable status before writing.** Not taken: by the time the guard runs, the stale write may already be past the check inside `Session.updatePart()`'s async preamble; checking earlier cannot close a window that lives between check and commit.

**Monotonic status versioning in the storage layer (last-writer-wins with a state machine).** Not taken: it pushes a session-lifecycle rule into shared storage, adds a version field to every part write, and still needs call-level serialization to decide which writer is "later" — the same queue, one layer down.

**Repair pass that re-settles durably nonterminal parts after the fact.** Not taken: it heals the symptom after persistence instead of fixing the ordering, doubles terminal writes during the repair window, and needs its own trigger and guard against repairing genuinely backgrounded tools.

## Consequences

Terminal tool states can no longer regress after late output or metadata updates: the completed/error part with its output and `time.end` is the last durable write for a settled call. The cost is that settlement waits behind at most the in-flight flushes already queued for the same call — bounded by writes that were going to happen anyway — and genuine long-running tools keep their streamed metadata until they actually finish. The regression suite covers completion and error settlement racing an in-flight flush, updates queued after settlement, and confirms a genuinely running tool still persists metadata while executing.
