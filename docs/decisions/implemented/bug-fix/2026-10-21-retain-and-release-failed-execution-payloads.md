# Decision Record: Retain and release failed execution payloads

Status: implemented

## Problem

Part persistence failures retain complete snapshots for recovery. Excluding those snapshots from the streaming buffer's resident-byte accounting admits more output after the existing 64 MiB limit is occupied. Cloning failed snapshots during a drain also makes recovery require additional capacity for payloads already retained.

Cortex terminal status is observable before parent delivery and settlement finish. A recording failure after that publication can bypass retention scheduling, while repeated finalization stops at the terminal-state guard. The task and its payload then remain in the live map until Runtime disposal. A cleanup callback that closes over the complete terminal task also retains payloads independently of the live map's prompt compaction.

## Decision

[PartWriteBuffer](../../../../packages/harness/src/session/part-write-buffer.ts) counts each buffered, running or failed entry exactly once against the existing byte limit. Failure transfers an executing snapshot into retained failure ownership without releasing its bytes. Retry transfers that same caller-isolated snapshot back to execution without cloning or admitting another copy. A newly admitted same-key snapshot replaces buffered and failed entries but does not replace still-running entries; failed admission preserves the previous payload and error. Successful writes and superseded failures release their own accounted bytes.

[Cortex](../../../../packages/harness/src/cortex/manager.ts) registers one pair of retention timers per task immediately when it publishes terminal state, including cancellation and timeout publication during concurrent finalization. Subsequent notification, metadata or settlement errors cannot cancel that responsibility and retain their existing error propagation. Timer callbacks capture task and session identifiers plus Runtime-owned state, not a complete terminal task. The existing 30-second prompt/progress compaction and five-minute live-task removal delays remain unchanged; durable child metadata remains the result-retrieval source after eviction.

## Alternatives considered

**Clear failures or truncate payloads.** Either approach loses recoverable content or error evidence instead of correcting ownership. Retaining complete snapshots under accurate accounting preserves recovery without another budget.

**Clone and re-admit failed snapshots.** Charging both copies can prevent a full buffer from recovering. Reusing the owned flush-time snapshot retains caller-mutation isolation without duplicating its resident charge.

**Schedule cleanup only after settlement or swallow recording errors.** Late scheduling leaves terminal tasks dependent on fallible delivery work. Swallowing errors hides incomplete durable recovery. Scheduling idempotently at publication separates eventual release from those operations without changing their result.

## Consequences

The buffer's serialized-byte limit includes failed payloads rather than claiming to bound total process RSS or transient cloning/serialization allocations. Producers retain the existing incremental deferred-byte estimates and exact flush-time validation. No payload truncation, additional capacity limit, event-payload change or persistence redesign is introduced.

[Buffer regressions](../../../../packages/harness/test/session/part-write-buffer.test.ts) cover eight retained 8 MiB failures, rejected admission, repeated and concurrent drains, snapshot identity and complete content, plus same-key replacement with overlapping running and deferred payloads. [Cortex regressions](../../../../packages/harness/test/cortex/cancel-queued-followups.test.ts) reuse real Runtime/SQLite fixtures with targeted storage-write failures and controlled active timers, covering ordinary completion of cancellation, notification and settlement failures, concurrent terminal publication, repeated cancellation, retention deadlines and durable lookup after eviction. Existing cancellation and runtime-timeout regressions remain in place.
