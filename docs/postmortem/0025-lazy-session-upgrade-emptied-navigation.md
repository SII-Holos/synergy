# Lazy Session upgrade emptied navigation

## Executive summary

After updating and starting managed Desktop, an existing installation showed projects but no historical sessions. Canonical Session and message records remained present. A navigation migration read historical metadata without its on-access upgrade, rejected it against the new Scope schema and persisted empty indexes. Separate tests for lazy upgrades and navigation did not cover their startup interaction or recovery after the incorrect migration had already completed.

## Summary

The running backend used the original database and returned an empty global session list. Read-only inspection found canonical sessions and messages, four empty navigation indexes and repeated malformed-session warnings during navigation reconstruction. Historical metadata became valid through the existing workspace-binding normalizer without changing unrelated Session fields.

## Timeline

- September 21: nullable workspace and embedded Scope bindings adopted an owner-local on-access migration.
- September 22: an update ran navigation reconstruction before historical Session access and recorded its empty output as complete.
- Investigation separated raw record availability from navigation responses and identified the missing `scope.local` field in untouched historical records.
- Isolated regressions reproduced both initial omission and an already-completed migration with empty persisted indexes.

## Root cause

Ordinary Session access used `SessionRecords.readMany`, which applies registered owner upgrades. Navigation reconstruction used `Storage.readMany` and immediately applied the current Session schema. The global on-access migration receipt announced the migration's availability; it did not mean every owner had been converted. Later normal Session accesses converted some records but did not reconstruct the already persisted empty index.

Navigation tests created Sessions with current writers. Lazy-upgrade tests did not rebuild navigation from untouched historical owners, and neither test covered reopening a store after the faulty derived migration was recorded complete. Green checks therefore did not establish that existing user history remained discoverable across the combined changes.

## Guardrails added

- The [navigation reader](../../packages/harness/src/session/nav.ts) applies the canonical metadata upgrade before validation and records redacted schema issue paths and codes for malformed input.
- The [registered repair migration](../../packages/harness/src/session/migration.ts) restores previously persisted incomplete indexes through normal startup and retains owner-local deferred preparation.
- The [upgrade tests](../../packages/harness/test/session/nav-upgrade.test.ts) cover historical project and Home Sessions, mixed owner receipts, archive and child identity, retained fields, untouched history, rollback and actual Runtime reopening.
- The [persistence skill](../../.synergy/skill/change-persistence/SKILL.md) requires projection readers and already-completed bad projections in lazy-upgrade verification.
- The [decision record](../decisions/implemented/bug-fix/2026-09-22-upgrade-session-metadata-before-navigation.md) records the metadata-only repair and rejected alternatives.

## Lessons

A derived projection is a reader of canonical data and must cross the same upgrade boundary as ordinary access. Skipping schema failures can conceal an upgrade-order defect as an empty product. A fix must restore installations that already persisted the bad projection, not merely make a fresh upgrade succeed.
