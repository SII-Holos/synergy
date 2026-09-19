# Decision Record: Batched snapshot ownership checks and parallel fork preparation

Status: implemented

## Problem

Session fork latency grows with history size in two places. `SnapshotLifecycle.adopt` verified each candidate snapshot root with its own `git rev-parse --verify` (shared backend) or `git cat-file -t` (legacy backend) subprocess and created each retention ref with its own `git update-ref` process, so a long coding session paid process spawn latency per snapshot step, all while holding the session file lock. `Session.fork` then cloned every message serially, and each completed tool part copied its output artifact chunk by chunk (read-side sha256 verification plus a nested storage transaction per flush), so fork time was the sum of all artifact copies even though the copies are independent of one another.

## Decision

`SnapshotStore.ownsMany(scopeID, sessionID, hashes)` answers the whole ownership set with one git subprocess: `git for-each-ref` over the session's `refs/synergy/snapshots/<sessionID>/` prefix on the shared backend, where ownership is defined by ref existence, so the ref listing is equivalent to per-hash `rev-parse --verify`; and `git cat-file --batch-check` on the legacy backend, where object existence and the `tree` type are the criterion. Invalid OIDs are rejected before the subprocess and report as unowned, matching `owns`. `SnapshotStore.retainMany` writes the retention refs in one `update-ref --stdin` transaction using the same `update <ref> <value>` records `adopt` previously issued one process at a time. `adopt` uses both; its `allowMissing` fallback still probes only the hashes the batch check reported missing, so the [shared file snapshot storage](2026-09-07-shared-file-snapshot-storage.md) archive-import contract keeps its per-root behavior.

`Session.fork` pre-assigns cloned message and part IDs serially before any work starts — preserving the source's relative order and making the parent map complete — then prepares messages with `workMap` at bounded concurrency, and prepares each message's parts (and a tool part's attachments) the same way. Artifact copies, attachment captures and `preparePart` are independent per part; the serial write transaction afterwards is unchanged, so persistence order and rollback semantics are untouched. `workMap` preserves input order in its results, so cloned messages and parts keep their original sequence.

## Alternatives considered

**Parallelize only at the message level.** Long single-turn stretches (one assistant turn with many tool calls) would stay serial. The part is the unit that actually owns an artifact copy, so the inner level is where the wall is.

**Parallelize inside `RolloutArtifact.copy` per chunk.** Chunk order defines the concatenated artifact and each flush commits chunk metadata in a nested transaction; out-of-order chunks would need sequence buffering for no gain on the dominant small-to-medium outputs. Per-part parallelism multiplies whole-copy throughput instead.

**Raise the concurrency above 8.** Copies drain through the single SQLite writer queue; beyond a small pipeline, more in-flight copies only deepen the writer queue. The bound matches the sizing already used for page hydration and per-session migrations.

**Share artifact blobs instead of copying (reference re-binding).** A sha256-addressed blob shared between sessions would remove the copy entirely, but artifact ownership and garbage collection are per-session; that is a storage-layer change on the scale of shared snapshot storage, not a fork-path fix.

## Consequences

Fork verification and ref creation now cost two git subprocesses regardless of hash count on both backends (plus per-root probes only when `allowMissing` needs them), and prepare-phase artifact copying overlaps up to 8 copies. Forked tool output remains byte-exact with fresh per-session artifact IDs, and `RolloutArtifact.list` still shows disjoint artifact sets between source and fork. The single-hash `owns` and `retainCurrent` paths and their callers (snapshot export, maintenance verification, restore) are unchanged; adopting `ownsMany` there is follow-up work, not a contract change. `SnapshotStore.command` gained an optional stdin parameter; existing callers are unaffected.

Coverage: `packages/harness/test/snapshot/store-batch.test.ts` covers batched ownership on both backends (owned, missing, invalid and duplicate hashes) and that `adopt` creates a ref for every retained snapshot; `packages/harness/test/session/fork.test.ts` covers a twelve-tool-output fork for byte-exact artifact content, per-session artifact ownership and preserved part identity; the existing snapshot, lifecycle, isolation, rollback and tool-output suites cover the regression surface.
