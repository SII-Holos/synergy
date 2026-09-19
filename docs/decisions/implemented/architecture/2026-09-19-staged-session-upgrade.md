# Decision Record: Staged Session Upgrade

Status: implemented

## Problem

Full historical backup, repeated scans and per-record commits delay first useful work. Deferring imports alone cannot solve this while migrations and recovery assume a complete dataset. Importing inside a caller's transaction can also retire files before its SQL changes commit, and fail-fast parallel work can outlive the storage Handle.

## Decision

The central registry classifies migration scope. Explicit Session and derived callbacks run on first access or during background convergence; shared and unknown migrations remain startup barriers. Persistent cohort records and per-owner receipts keep completion truthful across interruptions. Default staged eligibility requires historical ledger evidence that every shared migration has completed. This extends the [deferred import decision](2026-09-19-deferred-session-import.md); its ownership and retirement safeguards remain applicable to existing manifests.

Version 3 freezes Session sources by durable rename, seals global backup bytes before activation, and seals independent owner segments before import. Unfinished backups require the matching frozen source. Restore materializes missing segments and validates every segment before publishing a separate Home. No subsequent SQL writes enter the historical backup.

Import cannot execute or await another importer inside a business transaction. Owner recovery precedes publication, and source retirement follows independently committed records and full verification. Parallel workers stop scheduling after failure and drain started work before rejecting. Pending listings use a separate SQL catalog; the background importer bounds batches, prioritizes recent activity, retries with backoff and drains at shutdown. Bounded Session rewrites and inbox receipts batch commits; packed owner scans decode only the selected records.

## Alternatives considered

**Run every historical migration before HTTP admission.** This remains the fallback for unknown or shared migration dependencies. Applying it to separable owner work unnecessarily delays new tasks.

**Replay a second migration registry per Session.** This risks losing optional-domain migrations and dependencies. The same registry owns both resident and deferred work.

**Call frozen originals a complete backup.** A rename does not create independent bytes. Segmented restoration explicitly requires the frozen source for any unsealed owner.

**Detach import from a business transaction while its writer lock is held.** An independent commit can deadlock against that caller. Public Session mutations preflight import, and nested pending access fails without deleting evidence.

## Consequences

Eligible homes admit new tasks while idle history converges. Older releases needing Scope or other shared upgrades still wait for those barriers. Quarantined owners prevent cohort completion and portable transfer. Backup source identity and additional per-owner receipts add durable state, and a single large owner remains an indivisible scheduling unit. Synthetic timings are useful for regression comparison but do not establish production p95 or a universal speedup.

Behavioral coverage includes released writers, eligible default activation with new task creation, rollback, drained failures, metadata catalog isolation, retry fairness, source drift, incomplete backup restore and per-owner migration restart.
