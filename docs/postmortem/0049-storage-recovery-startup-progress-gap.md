# Subsystem completion was mistaken for Runtime readiness

## Executive summary

Managed Desktop stopped a backend after migration completion while storage recovery was still unfinished. The supervisor inferred whole-Runtime readiness from subsystem progress transitions. Separate migration, maintenance and execution-history tests missed their connecting work and later service initialization. Complete startup must have an enclosing lifecycle with one terminal readiness event, independent of local progress reports.

## Summary

The current launch's structured output showed completed index maintenance, a storage ownership check and `starting`. It contained neither storage completion nor execution-history recovery. Desktop then terminated the child after its ordinary health budget. The generic health failure was a consequence of incomplete startup reporting; the log did not identify the individual slow recovery operation.

## Timeline

- Read-only correlation of the current launch distinguished this timeout from the previously repaired legacy-metadata rejection.
- Code tracing located artifact collection, registered resource recovery, quarantine loading and notification reconciliation between the last reported event and storage completion.
- A real Runtime, SQLite store, CLI reporters and Desktop waiting policy reproduced expiration at each of the three unreported recovery entry points using a controlled clock.
- Structural review found the same risk after execution recovery and found that HTTP health could admit the server before later hooks finished.
- Lifecycle readiness, automatic component progress and detailed recovery coverage were added without changing user data or increasing the ordinary timeout.

## Root cause

`createManagedMigrationReporter.summary()` emits `starting` when the central migration runner returns, even when there are no pending migrations. Desktop interpreted that local completion as restoring its 30-second health deadline. `RuntimeHandle.open()` then performs additional storage recovery before emitting storage completion. Those operations lacked both an initial stage announcement and incremental work counts. The same short deadline returned after execution recovery although extension and service work remained. Consequently, a legitimate startup could be terminated as an unresponsive server; a listening HTTP endpoint could also be accepted prematurely.

Previous fixes instrumented legacy import, driver maintenance and execution-history replay individually. Their unit tests supplied expected progress sequences or used small fixtures that completed within the health budget. They did not test the composed post-migration storage recovery interval. The evidence establishes this timeout mechanism, but cannot retrospectively identify which uninstrumented operation consumed the observed interval.

## Guardrails added

The [decision](../decisions/implemented/bug-fix/2026-10-06-storage-recovery-startup-progress.md) makes Runtime readiness independent of subsystem completion. Component composition observes completed hooks automatically, so new component work cannot omit its outer progress report. [Composed startup tests](../../packages/presets/test/server/storage-startup-progress.test.ts) verify delayed stages, actual notification batches, multiple uninstrumented components beyond the inactivity budget, late failure and cancellation, retry and bounded silence. Desktop tests reject early HTTP health, duplicate and regressive stage activity, and readiness during unfinished maintenance. [Artifact tests](../../packages/harness/test/storage/artifact-pack.test.ts) preserve collection and pinning semantics while checking progress. The [development workflow](../../.synergy/skill/develop-synergy/SKILL.md) requires these lifecycle checks, and the Electron fixture renders recovery and extension progress.

## Lessons

A migration summary is not a Runtime readiness signal. Review every awaited pre-admission operation together with its progress owner, and test transitions through real producers and consumers. A healthy fresh Home and a green progress renderer cannot establish that a large existing Home will remain observable during recovery.

## Subsequent correction

A later launch reached the new recovery progress and then exited on an inherited storage admission deadline. The [follow-up incident](0050-storage-admission-deadline-escaped-queue.md) records the backend defect and the missing real-data acceptance evidence. The lifecycle correction remains necessary; it did not establish that every operation inside that lifecycle could complete.
