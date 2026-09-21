# Optional format rewrite blocked startup

## Executive summary

A format migration re-entered normal startup despite an existing maintenance gate. Its eligibility predicate confused incremental-vacuum capability with an already applied format. Progress with an unknown total was rejected, and the completion receipt waited for reclamation after the data was already usable. Separate fixes to maintenance timeouts, format efficiency and progress had not been tested together across the actual startup path.

## Summary

The user observed a managed Desktop startup failure after five minutes at a migration step. Database index setup had completed. The remaining operation was optional whole-store conversion or its post-commit reclamation, with repeated zero-count progress visible to Desktop. The recovery screen exposed details but offered no way to continue safely or open usable data.

## Timeline

- September 20: the shared maintenance protocol and storage format optimization were introduced through separate changes.
- September 21: a managed startup encountered the format path after earlier maintenance had enabled incremental auto-vacuum.
- Investigation distinguished format publication from pending freelist reclamation and verified that the progress schema rejected advancing unknown-total counts.
- Reproduction also showed that retaining staged data across ordinary writes could publish stale records after a later resume.

## Root cause

The `startupSafe` predicate was true when incremental auto-vacuum was enabled. That prerequisite did not mean format conversion had completed, so the normal runner invoked a full rewrite. Format conversion then awaited reclamation before returning, coupling application readiness to a potentially long cleanup loop. Copy progress used `current > 0, total = 0`; the producer schema discarded these records, leaving the desktop no-progress timer without evidence of advancement.

Existing tests proved each local mechanism but did not prove the end-to-end invariant that an old, already incremental database opens without rewriting. A reclaim-only recovery state, missing central receipt, unknown-total copy, interrupted derived-node work, and ordinary writes between attempts were not combined in the startup acceptance matrix. Error UI and diagnostic bootstrap were also outside those tests.

## Guardrails added

- The [maintenance gate tests](../../packages/harness/test/migration/maintenance-gate.test.ts) prove ordinary startup never invokes optional work and dry runs do not change receipts.
- The [format readiness tests](../../packages/harness/test/storage/format-v3-readiness.test.ts) cover durable cursors, cancellation, new writes after interruption, old staging, atomic rollback and namespace protection.
- The [Desktop maintenance tests](../../apps/desktop/test/server-maintenance.test.ts) cover active-work refusal, duplicate operations, owned-child shutdown, retry and a controlled long interval. The [Electron fixture](../../apps/desktop/test/fixture/startup-progress.ts) exercises recovery controls in both themes.
- The [CLI recovery tests](../../packages/cli/test/cli/storage-maintenance.test.ts) export startup diagnostics with a corrupt database and retain only validated aggregate progress from logs.
- The [persistence workflow](../../.synergy/skill/change-persistence/SKILL.md) requires source mutation fencing and separate readiness and reclamation acceptance. The [maintenance recovery decision](../decisions/implemented/bug-fix/2026-09-21-format-readiness-and-maintenance-recovery.md) records the trade-offs.

## Lessons

An optimization prerequisite is not a startup eligibility test. Completion must describe the user's ability to use committed data rather than completion of every cleanup operation. A producer, central runner, wire schema, process supervisor and recovery interface need one behavioral acceptance path; tests of each in isolation did not prevent this recurrence.
