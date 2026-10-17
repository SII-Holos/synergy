# Cold navigation migrations made retained data appear empty

## Executive summary

Managed Desktop opened with an empty sidebar even though canonical conversations and project records remained present. First navigation rebuilt outdated indexes inside the shared writer and performed historical work. Concurrent readers timed out, while server and frontend error handling converted failure into empty-looking state. Startup readiness and warm navigation coverage missed the first cold projection after a composition change.

## Summary

Catalog and recent-list requests failed with storage admission deadlines while other narrow requests succeeded. An isolated snapshot reproduced blocked writes and incomplete navigation. The issue concerned admission and presentation; no deletion was required to produce the symptom.

## Timeline

The failing launch reached HTTP readiness, then catalog requests waited roughly thirty seconds for storage admission. A replay of the original path retained the writer until its ninety-second experiment guard interrupted work. Separating body preparation, batching metadata and deferring recovery enrollment restored successful first navigation. Deterministic tests capture writer progress, rollback and failure presentation independently of workstation timings.

## Root cause

Composition invalidation sent the first catalog read through reconstruction under one transaction. Session metadata access included a historical part migration and recovery enrollment for every old owner. Optional owner migrations also wrote receipts where their input was absent. A separate dispatch defect passed the internal Session discriminator to callbacks, overriding spread record-kind queries. Navigation swallowed failures, and the frontend treated rejected catalog loads as completed empty snapshots.

Real-data interaction acceptance also exposed reader saturation after the cold path was fixed. Each catalog refresh used an unbounded parallel read of all Scope records, including archived projects. Overlapping refreshes during streaming exhausted the reader queue. Scope listing now uses the storage batch-read contract instead of one admission per project.

The wider CI matrix caught a restart gap in the initial fix: legacy startup-residue validation recognized only canonical navigation version 1. A refreshed version 2 index therefore caused an inert empty initializer file to be rejected. The classifier now recognizes both canonical versions without broadening the historical file schema; restart tests retain original file bytes and continue rejecting foreign records.

## Guardrails

- [Navigation isolation tests](../../packages/harness/test/session/nav-read-isolation.test.ts) cover absent and partial indexes, rollback, concurrent readers and business publication between batches.
- [Metadata access tests](../../packages/harness/test/migration/session-access.test.ts) cover absent input, later input, dependencies and duplicate callers.
- [Legacy startup admission](../../packages/harness/test/storage/legacy-startup.test.ts) and [managed CLI readiness](../../packages/presets/test/cli/managed-readiness.test.ts) cover both canonical navigation versions, strict residue rejection and repeated startup.
- [Scope listing admission](../../packages/harness/test/scope/list-admission.test.ts) covers more projects than the queue limit and eight simultaneous readers over a largely archived catalog.
- [Historical cleanup](../../packages/harness/test/session/loop-guard-migration.test.ts) and [pause recovery](../../packages/harness/test/session/pause-recovery.test.ts) verify explicit preparation and durable restart behavior.
- [Full composition history acceptance](../../packages/presets/test/server/history-experience.test.ts) combines thousands of cold owners with HTTP navigation, old message pages and new Session creation.
- [Request ownership](../../apps/web/test/context/layout/nav-request.test.ts) and [rendered sidebar tests](../../apps/web/test/components/sidebar/sidebar-collections.dom.test.tsx) verify failure, retry, accepted emptiness and retained rows.

## Lessons

Application readiness does not prove first navigation is bounded. A composition-invalidated index must be tested with released metadata and missing receipts. Failure must remain distinguishable from accepted emptiness at both persistence and presentation layers. The [decision](../decisions/implemented/bug-fix/2026-10-17-cold-navigation-metadata-admission.md) defines the preparation and publication policy.
