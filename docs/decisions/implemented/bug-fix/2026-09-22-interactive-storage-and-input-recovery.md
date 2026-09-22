# Decision Record: Bound interactive storage and recover durable input

Status: implemented

## Problem

A server can finish its startup migrations and expose historical conversations while still being unable to process the next message promptly. Derived-node cleanup used a namespace-led query, retention estimated work in records while deleting nodes, and separate SQLite connections shared one synchronous worker event loop. Admission deadlines were checked after the preceding holder returned. The frontend interpreted a missing canonical message after thirty seconds as failure even when its Inbox item was durable. Historical execution ownership and a retained pause could also prevent a valid new or retried input from running.

## Decision

Cleanup starts at addressed keys and their ancestors. Online retention checks records, nodes, artifact references, recency and current execution under the deletion transaction; oversized owners wait for explicit offline maintenance. Offline pruning retains atomic owner deletion rather than introducing a new evidence generation or partially visible owner format.

SQLite reader and writer connections live in independent processes with separate admission queues. Pending work has a real deadline and cancellation, foreground admission has priority, and nested queues preserve the earliest budget. A failed reader can be replaced independently; an unavailable writer fences the store. Ordinary statements have a maximum sixty-second silence ceiling; explicit maintenance retains a separate finite engine budget. Slow successful operations and SQL are always sampled using redacted structural telemetry.

Input recovery projects existing Inbox, Message and Rollout records. Stable client message IDs deduplicate admission, materialization and cancellation. New task admission advances past historical or terminal roots before resolving execution configuration. Explicit retry rearms the saved item and clears the pause that prevents it from running. The frontend observes authoritative progress and canonical messages; duration and transport loss do not fabricate failure.

Context-usage projection updates preserve entity identity: same-message enrichment reconciles in place, while advancing to another message replaces the projection pointer. Root reconciliation cannot cross IDs because the projection may share its object with the visible transcript. Managed Desktop acceptance verifies that every previous reply remains visible while submitting subsequent turns, before any reload can repair the projection.

Desktop reserves admission before stopping its managed server for maintenance. The reservation rejects active or already-admitted work and expires if the client disappears. The CLI still acquires exclusive storage ownership before changing data.

The shared test planner runs the file-owned agent and worktree runtime fixtures in separate processes after two shared CI coverage runs timed out during their teardown. The paired Linux invocation passes all 75 cases, but the exact CI-only blocked resource remains unproven. This contains test-process lifetime interference while retaining every assertion, the existing timeouts and unioned coverage; final CI validates the isolation independently of local performance acceptance.

The inert-import check compares directory contents independently of filesystem enumeration order. Coverage failure summaries preserve bounded multiline assertion differences across blank separators, so a truncated full log still identifies the actual mismatch.

## Alternatives considered

- Longer global deadlines leave foreground calls trapped behind whole-store work and make failure recovery slower.
- Connections in one process preserve SQLite snapshot isolation but cannot answer reads while synchronous writer SQL occupies that process.
- Online generation-based garbage collection offers finer preemption but introduces persisted publication and recovery states solely to reclaim large owners. Explicit maintenance keeps the existing atomic evidence representation.
- A new durable input state machine duplicates Inbox and Rollout ownership and creates additional reconciliation cases after crashes.
- Timing thresholds on shared CI machines confound hardware capacity with correctness. CI checks ordering, isolation, bounded work, cancellation and recovery; local acceptance measures latency on declared fixtures.

## Consequences

Ordinary message processing no longer pays for unrelated historical node cleanup. Reader failure and writer occupation have separate readiness signals, and saved input has a visible recovery action. Two SQLite processes use more process and cache memory. Foreground priority can delay background progress under sustained demand. Large expired owners consume disk until the operator permits maintenance; cancellation preserves completed deletions and rolls back only the current owner. The finite ordinary SQL ceiling can reject an unexpectedly large foreground operation, so its transaction must remain recoverable.

See [Agent storage](../../../architecture/agent-storage.md), [durable input recovery](../../../architecture/session-and-messages.md#durable-input-recovery), the [incident](../../../postmortem/0026-started-runtime-stranded-saved-input.md), and [local validation](../../../research/2026-09-22-interactive-storage-validation.md) for the owning contracts and regression evidence.
