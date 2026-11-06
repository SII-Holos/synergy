# Managed startup maintenance outgrew Desktop's progress deadline

## Executive summary

Managed Desktop terminated a large existing home's startup after five minutes without a migration count change. SQLite maintenance had a longer finite driver budget, but Desktop did not receive it. Earlier fixes covered individual startup phases rather than the common driver boundary. Maintenance now reports one lifecycle across opening DDL, upgrades and verification, with regression coverage at both ends.

## Summary

The observed launch completed counted migration scans and entered an uncounted storage step. Desktop reported no progress for 300000 ms and terminated the server. The pending storage migration enabled incremental auto-vacuum. Older logs did not identify whether the remaining delay was the rewrite, checkpoint or return path, so the evidence establishes a deadline mismatch rather than a specific SQLite stall. Historical optional-service errors in the appended log tail were unrelated to the current timeout.

## Timeline

- Earlier changes added migration progress, recovery counts and storage bootstrap reporting.
- Physical integrity checking gained its own finite engine-budget announcement.
- Incremental vacuum and long opening index work later used driver maintenance deadlines without equivalent Desktop announcements.
- The September 20 report reproduced a five-minute migration inactivity timeout during an uncounted storage step.
- Real-engine and fake-clock regressions exposed the reporting gap and a failure-callback async-context leak; the shared lifecycle and explicit caller-context binding address both.

## Root cause

The consumer's item-progress contract and the driver's maintenance contract evolved independently. Parser fixtures proved that manually constructed progress could extend a wait, but not that every real maintenance path emitted it. Small databases completed before the competing deadline. Reusing an append-only log tail mixed earlier service errors into a new failure, while a large unbounded details panel displaced the visible reason.

## Guardrails added

- [Real storage maintenance tests](../../packages/harness/test/storage/maintenance.test.ts) cover opening DDL, checkpoint/rewrite stages, integrity checking and failed DDL with preserved data and caller-context reporting.
- [Verification tests](../../packages/harness/test/storage/verification.test.ts) retain WAL-sensitive budgets and transaction retries; [runtime tests](../../packages/harness/test/lifecycle/runtime.test.ts) cover an injected handle.
- [Desktop deadline tests](../../apps/desktop/test/server-startup.test.ts) cover five-minute maintenance, independent overlap, duplicate/stale events and terminal failures.
- [Managed child tests](../../apps/desktop/test/server-manager-ports.test.ts) separate old logs from the current failure; [Electron tests](../../apps/desktop/test/startup-progress-runtime.test.ts) verify elapsed time, indeterminate progress and a visible reason above long details.
- The persistence, isolated-development, testing, diagnostics and development-standards Skills route future changes through the [shared contract](../decisions/implemented/bug-fix/2026-09-20-startup-maintenance-contract.md).

## Lessons

A progress parser test cannot certify its producers. A long operation needs a finite budget from its owner, not invented activity from a timer. Diagnose one launch at a time and retain uncertainty when historical telemetry cannot identify a finer stage.
