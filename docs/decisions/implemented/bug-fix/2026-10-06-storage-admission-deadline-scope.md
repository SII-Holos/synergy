# Decision Record: Keep admission wait caps local to their queues

Status: implemented

## Problem

Startup artifact collection holds a filesystem coordination gate while it scans SQL references and files. `StorageQueue` propagated its default 30-second admission wait deadline into the admitted callback. A later SQL admission inherited that expired deadline and failed even when the reader was idle and collection was progressing. Large or slower histories therefore exited before readiness despite the enclosing Runtime progress protocol.

## Decision

Every `StorageQueue.run()` distinguishes the caller's request deadline from its local enqueue deadline. Waiting is bounded by the earlier of the local 30-second cap and the request deadline. Admission consumes that local cap; the callback inherits only explicit request deadlines, combined cancellation, priority and wait reporting. Nested queues preserve the earliest explicit deadline and cannot extend it.

This rule applies to all queue owners, including artifact operations, writes and SQLite lanes. Statement deadlines, finite maintenance budgets and Runtime startup inactivity supervision retain their independent ownership. Neither successful progress nor a new queue resets an explicit request deadline. Persisted formats and collection ordering do not change.

## Alternatives considered

**Increase the default queue timeout.** This moves the failure to a larger dataset or a slower disk and continues to confuse admission waiting with operation duration.

**Clear the deadline only during startup collection.** That would bypass explicit caller deadlines and leave the same defect in other nested queue users.

**Remove deadline inheritance.** Nested work could then outlive a caller's explicitly bounded request or override its cancellation. Only the generated local wait cap stops propagating.

## Consequences

An admitted multi-step operation may run longer than 30 seconds when its actual work allows it. It is still supervised by the owning Runtime, SQL worker or explicit caller. Queue saturation, cancellation, foreground priority and shutdown behavior remain bounded. Behavioral tests cross the default cap during real artifact collection while checking reference safety and durable pins; queue tests separately preserve local waiting limits and explicit deadline inheritance.

The [incident](../../../postmortem/0050-storage-admission-deadline-escaped-queue.md) distinguishes this backend failure from the earlier [Runtime readiness correction](2026-10-06-storage-recovery-startup-progress.md). A healthy small or warm fixture is insufficient acceptance evidence for a history-dependent startup defect.
