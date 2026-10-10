# Decision Record: Keep historical work outside runtime admission

Status: implemented

## Problem

Data scope did not determine execution policy. An owner-capable timing migration could still enumerate every Session and operation at startup, while missing recovery coverage caused a full journal replay. Page preparation and automatically resumed backfills added further historical work despite earlier staged-import and bounded-history decisions. Empty-install tests could not detect these costs.

## Decision

The central runner requires an explicit execution policy for migrations dated 20261008 onward, preserving released older registrations. Owner execution supports both Sessions and operations, orders dependencies, coalesces simultaneous preparation, and writes completion only after the owner succeeds. Changing an upgrade from a global pass to owner or record access removes its obsolete cohort barrier without claiming owner completion. Timing upgrades inspect current records one run at a time and preserve idempotent timing markers and original journal evidence.

Pure record upgrades run at the message/Part read boundary. Timeline requests seek bounded message-order pages; they do not initialize a complete in-memory order list or invoke whole-Session display backfills. Part presentation carries a cache format version, so requested old pages rebuild without invalidating every historical message. Historical references lacking unambiguous recorded context remain unresolved rather than binding to a current directory.

Rollout admission retains known pending owners. Missing, malformed or incomplete coverage becomes a durable epoch, with the malformed source preserved. Before an owner's evidence read or mutation, its single-flight recovery verifies the journal and referenced evidence, settles interrupted work, and writes an epoch receipt. Recovery bypass is scoped to that owner, storage Handle and Runtime. New owners remain independent of corrupt cold history. Shutdown settles only owners touched by the current Runtime and retains other pending owners. Recovery never executes an external tool again.

Historical import is paused by a versioned policy migration. Explicitly selected owners can still import under the existing foreground budget and integrity checks. Usage jobs without an explicit request retain their cursor but do not run automatically. Selected statistics advance bounded usage preparation; an explicit full rebuild also repairs historical lineage before resuming its owner cursor. Original prices, source bytes and clear markers remain authoritative.

## Alternatives considered

**Run all upgrades before readiness.** This makes application admission proportional to historical data and repeats journal reads for derived corrections.

**Automatically drain history after readiness.** It competes with new work for disk, CPU and the single writer, and does not match the selected on-demand policy.

**Clear an unknown pending set.** This would falsely certify owners never inspected and permit execution against interrupted evidence.

**Declare the UI ready before required startup work completes.** This masks admission failures; required global metadata/schema and ownership checks must still finish.

## Consequences

The [startup fixture](../../../../packages/harness/test/lifecycle/history-startup.test.ts) uses real SQL storage with 0, 1,000 and 10,000 cold Sessions and operations, and absent, interrupted and completed timing migration states. It asserts no cold-history reads during Runtime readiness and verifies new operation admission. The [owner runner](../../../../packages/harness/test/migration/owner-execution.test.ts), [recovery](../../../../packages/harness/test/session/rollout-pending.test.ts), [page](../../../../packages/harness/test/session/display-page.test.ts) and [usage](../../../../packages/harness/test/usage/migration.test.ts) tests cover retries, concurrency, corruption, incomplete coverage, owner isolation and explicit resume. These fixtures measure Core admission and row access, not Desktop rendering or physical 100 GB transfer throughput.

A selected owner's first evidence access can still require its integrity recovery. Strict historical revision reads, exports and explicitly requested full maintenance retain complete verification. Unknown older shared migrations and released snapshot ownership inventory retain their existing startup requirements. Historical statistics remain explicitly incomplete until enough requested history or a full rebuild has been processed. Current contracts live in [Agent storage](../../../architecture/agent-storage.md) and [usage accounting](../../../architecture/usage-accounting.md); the preceding [demand-driven upgrade decision](2026-10-03-demand-driven-history-upgrades.md) explains the original separation of navigation and history preparation.
