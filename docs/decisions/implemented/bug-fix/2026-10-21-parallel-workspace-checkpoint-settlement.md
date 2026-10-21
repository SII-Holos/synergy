# Decision Record: Parallel Workspace checkpoint settlement

Status: implemented

## Problem

Ending an execution segment waits for each Workspace endpoint capture in sequence. Independent Workspace indexes also share a session-wide lock, so parallelizing only the caller does not overlap capture. Pause and the next execution baseline retain this filesystem cost even though foreground reply completion is published independently. Removing that session lock would break adoption and permanent-deletion exclusion.

## Decision

`SnapshotStore.parallel` owns the existing shared Scope lease and session lock for a finite batch. Only matching active batch context can use independent index locks instead of reacquiring that ownership. Index paths remain authoritative: shared Workspace bindings have separate indexes, while legacy repositories retain their common index and serialization. Existing Runtime-aware context rejects foreign Runtime ownership, and batch context expires before the outer lock releases.

`SessionFileChanges.finish` closes admission and drains already admitted baselines before endpoint work. A single Workspace uses the direct endpoint sequence without batch admission; multiple Workspaces capture, compare and publish concurrently through the batch. Every admitted branch settles before the batch releases its session ownership. Summary settlement runs once outside the batch, including after failed checkpoint attempts, preserving partial or failed evidence rather than publishing an empty successful comparison.

Git retention reference writes share a short process-safe session lock across capture, batched adoption and durable-cache restoration. Durable content retention remains required after reference publication and outside this short lock. Repository initialization, large object imports, pruning and physical session cleanup retain their existing exclusion. Execution ownership remains held until checkpoint attempts finish; new turns cannot establish their baselines against unfinished old endpoints.

Durable content preparation serializes only competing captures of the same Scope, session and tree root. A published manifest returns through the existing fast path; a missing manifest is rechecked after content-lock admission before packing. Distinct roots remain independent. Failed preparation publishes no manifest and releases admission so the next caller can retry.

The existing [foreground completion decision](2026-10-09-foreground-reply-completion.md) and [object import decision](2026-10-04-snapshot-object-import.md) remain applicable. This change alters neither capture policy nor persisted snapshot formats.

## Alternatives considered

**Parallelize only the endpoint loop.** The existing session-wide lock serializes the actual captures, leaving the dominant dependency unchanged.

**Replace the session lock everywhere with Workspace locks.** Lifecycle consumers use session exclusion to protect adoption and deletion. A controlled batch retains those consumers without introducing another reader/writer ownership ledger.

**Release execution ownership before endpoint capture.** A subsequent turn could modify files while the preceding endpoint is still being read, changing checkpoint attribution and restoration evidence.

**Trust unchanged timestamps or omit shared Workspaces.** These approaches change byte-verification or coverage semantics and can miss external writes. They are independent product decisions, not substitutes for removing unnecessary serialization.

## Consequences

Independent endpoint captures can overlap without weakening session lifecycle exclusion. The batch drains failures instead of abandoning sibling publication, and all summary work runs after its locks release. Same-index operations and shared object publication still serialize where required. Concurrent captures can increase transient memory and filesystem contention; before/after process measurements must report that cost alongside complete pause-to-drain latency, with identical frozen directory data and validated checkpoint contents.

The [real-process measurements](../../../research/2026-10-21-parallel-workspace-checkpoint-settlement.md) do not grant performance acceptance: pause gains vary across rounds, and subsequent input latency and sampled server CPU regress. Host contention limits causal attribution, not the requirement to resolve those regressions before deployment or merge. Implemented lock behavior and passing correctness tests must not be presented as a verified whole-interaction performance improvement.
