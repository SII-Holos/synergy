# Decision Record: Historical preparation access and retry status

Status: implemented

## Problem

Preparing unpublished history must write retained tool output before ordinary access becomes safe. Applying the ordinary admission check to that internal write prevents completion. Separately, returning an earlier failure while a new attempt runs makes the Web preparation controller stop polling before the attempt settles.

## Decision

Binary writes obtain their existing-content snapshot through the same migration-aware Storage surface as binary reads. Byte flushing remains outside business transactions, and ordinary callers remain subject to owner admission. The [storage architecture](../../../architecture/agent-storage.md) owns this access rule.

Preparation status gives an active attempt precedence over a prior error and omits that stale error from its response. It samples active work before and after the asynchronous locator read so an attempt finishing during that read cannot expose an outdated failure as terminal. Durable imported and quarantined states retain precedence. The [frontend synchronization document](../../../architecture/frontend-data-sync.md#historical-preparation) owns the polling semantics.

## Alternatives considered

**Publish before evidence conversion.** This would expose incomplete history and indexes to ordinary readers. Keeping migration access scoped allows evidence conversion to finish before publication.

**Clear the durable failure whenever background work starts.** This adds a write and removes diagnostic evidence before a successful retry. Projecting active status retains that evidence until the existing completion path replaces it.

**Poll every failed response indefinitely.** This makes the client infer whether a retry exists and would keep polling terminal failures. The server already owns the attempt and can report its state directly.

## Consequences

The change adds no schema, migration ID or compatibility reader. Released-ledger tests cover deferred tool output, startup recovery and restart idempotence; admission tests retain the ordinary-access restriction. A status sampled during completion may report preparing for one additional poll, while settled failures and quarantine remain visible. The [postmortem](../../../postmortem/0022-historical-preparation-admission.md) records the verification gap.
