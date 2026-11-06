# Decision Record: Storage upgrade hot path

Status: implemented

## Problem

The JSON-to-SQL upgrade wall serially backs up, imports, migrates and verifies a Home before activation, and the first measured end-to-end run (synthetic homes mirroring released writer shapes, isolated `SYNERGY_HOME`, full bootstrap chain) attributed a 6 GiB / 195k-file home's 364 s wall to three avoidable cost centers: activation retirement re-digested every legacy file after the import had already hashed and checkpointed each one (~70 s), backup compression ran synchronous single-threaded gzip per entry while later files waited unread (~60 s), and six per-session domain migrations processed sessions strictly sequentially (~127 s dominated by read-modify-write scans). Desktop and CLI users pay this wall synchronously on first start after upgrade, so every second is user-visible downtime; #1398 already had to add deadline tolerance just to keep managed startup alive through it.

## Decision

Three targeted changes keep the single-authority model, the sealed-backup contract and all import checkpoints intact:

- **Retirement verification remains complete.** `verifyRetirement` checks byte counts and the full content digest for every source and backup record, regardless of inventory size. Only source absence is tolerated on resumed retirement. Atomic replacement can preserve byte count, and an exclusive Home lock cannot establish backup integrity; neither permits sampling before deleting the original.
- **Backup compression pipelines across the zlib threadpool.** Packed backup creation keeps up to 8 compression flights in flight while later source files stream in, drains in source order so sealed groups stay byte-identical with the synchronous layout, and moves the group index frame to async gzip. A flight failure is captured and rethrown at the drain point so concurrent failures cannot become unhandled rejections.
- **Six hot per-session migrations run with bounded concurrency (8)** via the existing `work()` primitive: message semantics derive, inbox delivery receipts (batched at 256), parent pendingReply recompute, bounded session data, rollout evidence, and snapshot per-session git init. Safety comes from task isolation — every task touches only its own session subtree — and from the SQLite driver, which already serializes writer transactions through its own queue while reads overlap.

The earlier sampling prototype measured on the same fixture harness (medium 643 MiB / heavy 6.1 GiB, cold upgrades, isolated homes): backup phase 60.5 → 24.1 s (heavy) and 4.2 → 2.3 s (medium); activation 80.8 → 69.3 s; whole-wall 363.7 → 328.8 s (heavy) and 58.8 → 49.5 s (medium); light homes drop from 3.4 s to 3.0 s. Migration phase moves 27.5 → 23.6 s on medium and stays within run-to-run variance on heavy, where the single SQLite writer's per-commit fsync bounds commit throughput regardless of client concurrency.

## Alternatives considered

**Sample retirement digests.** Rejected during review: equal-length edits and backup corruption escaped verification at unsampled positions, after which retirement deleted the intact original. Full digest verification preserves the recovery contract; the concurrency improvements remain independent of this requirement.

**Move-instead-of-copy or artifact-referencing sealed backups.** It would remove most backup I/O but changes the version 2 backup format and its independently-readable restore contract, which the downgrade path depends on. Rejected for this change; revisit only with a versioned backup format.

**Defer legacy import to background or split new/old storage.** The compat design (SQL for new writes, JSON lazily imported per aggregate) requires shrinking the sealed whole-home backup scope and replaying domain migrations per deferred aggregate — a much larger architectural change. This change captures most of the wall reduction without touching that surface; the deferral remains available if real-world storage distributions still show unacceptable first-start times.

**Higher migration concurrency or cross-process parallelism.** The SQLite worker executes on one connection and every commit fsyncs (`synchronous = FULL`), so beyond a small client-side pipeline, added concurrency only deepens queues. 8 matches the existing worker-pool sizing; process-level parallelism would duplicate the store and contradict single-namespace ownership.

## Consequences

Backup compression and independent migration reads overlap while every retired file retains full integrity verification. The measurements above include the rejected sampling prototype and do not establish the final end-to-end speedup; representative measurements of the final implementation remain necessary before publishing performance claims. Existing migration and packed-backup suites cover the concurrent paths; retirement tests cover missing files, size drift and equal-length content corruption.
