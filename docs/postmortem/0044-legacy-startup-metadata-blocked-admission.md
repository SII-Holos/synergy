# Legacy startup metadata blocked database admission

## Executive summary

Managed Desktop could not open an active SQL Home after a retired runtime recreated only startup metadata. The legacy-writer guard treated empty initialization artifacts and migration receipts as conflicting business records. Tests covered foreign data but not an otherwise intact SQL Home with harmless startup residue. Admission must distinguish these cases without importing or removing the evidence.

## Summary

The backend exited during storage preparation and Desktop displayed a failed health request. The earlier backend error identified recreated JSON records. The relevant files contained migration completion timestamps, an empty Home navigation index, a default reclaimed Scope and empty plugin metadata. SQL still held the authoritative history and configuration.

## Timeline

- The managed startup failure was correlated with the current backend launch rather than historical log entries.
- Read-only inspection identified the residual initializer formats and the corresponding SQL records.
- A synthetic fixture reconstructed the failure after activating records from a released writer.
- Shared admission tests verified repeat startup without changing SQL authority or residual bytes.

## Root cause

The guard classified authority from a legacy pathname alone. That correctly blocked divergent session and permission data, but did not distinguish inert initializer output. The healthy database was therefore unavailable even though reimporting or deleting files was unnecessary. The health-check message was a downstream symptom, not a network failure.

## Guardrails added

The [admission decision](../decisions/implemented/bug-fix/2026-10-04-legacy-startup-metadata-admission.md) defines the bounded, read-only exceptions. The [storage regression](../../packages/harness/test/storage/legacy-startup.test.ts) retains original bytes, canonical history, current migration receipts and permissions across repeated startup. Existing bootstrap and deferred-owner tests keep foreign business records fatal. The [persistence workflow](../../.synergy/skill/change-persistence/SKILL.md) requires this distinction when changing post-activation checks.

## Lessons

A pathname indicates where a historical writer stored data; it does not establish that every file there carries new business authority. Safe recovery can preserve evidence in place while validating a narrow inert format. Broad JSON suppression and automatic reimport would both hide meaningful conflicts.
