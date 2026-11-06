# Decision Record: Share SQLite maintenance lifecycle with managed startup

Status: implemented

## Problem

Managed Desktop's five-minute item-progress deadline could terminate a legitimate database rewrite whose driver allowed longer. Earlier migration, recovery and integrity-check fixes covered individual call sites; later VACUUM and opening index work bypassed that reporting. A reused log tail and an unconstrained error panel obscured the current failure. See the [incident](../../../postmortem/0020-startup-maintenance-deadline-drift.md).

## Decision

The SQLite driver owns typed begin, optional stage and completed/failed transitions for VACUUM, reclaim, integrity checks and index DDL. The shared startup schema carries only bounded enum values, operation IDs and durations. Budgets include the existing snapshot-sized deadline and bounded liveness probes. `RuntimeHandle.open` observes the entire startup, including opening DDL and injected storage. A bounded queue preserves transitions, while an explicitly bound caller context keeps reporting outside retryable transactions.

Desktop tracks each operation independently with a monotonic clock and five seconds of transport allowance. Repeated starts, stages, item counts and stale terminal records cannot extend an active operation. Overlap selects the earliest deadline; completion restores the underlying phase's ordinary wait, and failure is terminal. Existing health and item-progress deadlines remain unchanged. The older `validate-engine` record remains a decode-only boundary for older managed binaries; new producers use the lifecycle. Remove that boundary when older binaries are no longer accepted by Desktop's source fallback/packaged compatibility policy.

Maintenance displays its operation, available stage and elapsed waiting time without a fabricated percentage or ETA. Errors retain a bounded per-launch stdout/stderr tail rather than rereading historical logs; the reason stays visible above scrollable details. No schema version, migration identifier, HTTP API or PostgreSQL maintenance semantics changes.

## Alternatives considered

**Increase all startup timeouts.** This hides genuinely stalled scans and ordinary server failures, while another larger database can exceed the new constant.

**Emit timer heartbeats or progress from every migration.** Heartbeats do not establish work and scattered reporters repeat the drift that caused this regression. Opening DDL also occurs before migrations can report it.

**Add another special VACUUM startup phase.** It repairs this call site but leaves index creation, reclaim and future maintenance on separate timeout contracts.

## Consequences

Long maintenance stays bounded without competing with the item-progress deadline. Real-engine tests cover lifecycle production and transaction context; Desktop clock tests cover deadlines and stale/overlapping events; Electron tests cover indeterminate waiting and long failure details. The observer adds a bounded queue and in-memory IDs but does not persist another maintenance ledger. Older progress records have one narrow compatibility decoder instead of another current producer.
