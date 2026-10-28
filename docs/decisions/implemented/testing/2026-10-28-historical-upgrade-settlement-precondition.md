# Decision Record: Settle historical migrations before checking upgrade idempotence

Status: implemented

## Problem

Historical Session preparation publishes a readable owner before finishing global after-convergence migrations. A test that observes public `ready` and immediately demands a zero-work migration rerun can inspect an unfinished receipt. Session readability and completed migration accounting are different prerequisites.

## Decision

The [released-project upgrade fixture](../../../../packages/presets/test/storage/released-project-upgrade.test.ts) first verifies both historical Sessions through the public preparation API and reads their retained content. It then awaits the existing `completeDeferredMigrations()` operation before requiring `{ completed: 0, failed: 0 }`. All version/directory combinations, first-start and restart checks, content preservation, new work, deadlines and coverage thresholds remain intact. Failed assertions include the restart phase and migrations started by the rerun.

The [convergence regression](../../../../packages/harness/test/migration/convergence-gate.test.ts) uses real isolated storage and an explicitly held migration. It observes a readable owner with an unfinished receipt, joins settlement, releases the migration and requires one execution, a completed receipt and a zero-work rerun. Cleanup releases and drains outstanding work without sleep-based admission.

## Alternatives considered

**Serialize every migration runner in production.** Startup migration runs before historical import, and offline maintenance owns the Home exclusively. The integration fixture directly invokes the runner inside an online Runtime. Adding production serialization for this test would change execution policy without demonstrating a competing production caller.

**Allow a nonzero completion count or repeatedly rerun until idle.** Either approach weakens the idempotence check and can conceal genuinely missing receipts or repeated work.

**Increase deadlines or retry CI unchanged.** Neither establishes ordering between owner publication and migration settlement.

## Consequences

The correction changes tests, not public readiness or migration execution. The settlement wait is valid here because every historical fixture owner is confirmed ready; it does not drain arbitrary pending, partial or quarantined history. Controlled counterexamples establish the missing prerequisite, not the identity of a migration omitted from an earlier CI failure's diagnostics. The retained reporter helps attribute subsequent failures without claiming that every completion increment executes a migration body.
