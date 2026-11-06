# Absent compute discarded an unfinished release

## Executive summary

A completed conversation left an execution staging volume behind after container deletion returned an error. Recovery observed absent compute, cleared the allocation and stopped retrying cleanup. A host correctly retained the volume and refused to release its worker lease. Tests asserted the logical idle state without checking residual provider resources.

## Summary

Idle reclamation saved the Workspace and started deleting its Docker allocation. The container disappeared but its deletion returned HTTP 503. A later reconciliation marked the Environment idle while its volume and provider receipts remained. The original acceptance result and retained files were preserved for diagnosis.

## Timeline

- 2026-10-06: isolated acceptance stopped on unconfirmed worker retirement.
- Compared the provider error, absent container, retained volume and durable Environment record.
- Added regressions that failed with idle after partial deletion and unavailable after repeated checkpoint failure.
- Reordered release recovery and verified the original request survives until resource saving and provider retirement finish.

## Root cause

Availability inspection answers whether compute exists; it cannot establish completion of an already-authorized release. The absent branch bypassed provider deallocation. Recovery's generic failure transition also replaced releasing with unavailable, losing the intent that distinguishes cleanup from ordinary availability reconciliation.

## Guardrails added

- [Implementation decision](../decisions/implemented/bug-fix/2026-10-06-resume-complete-environment-release.md).
- Harness provider-maintenance tests retain residual resources through repeated failures on SQLite and PostgreSQL, then verify cleanup without replacement allocation.
- Local Runtime's Docker regression loses a successful deletion response and checks saved bytes plus physical volume/network absence.
- The testing guide requires residual-resource assertions after partial deallocation.

## Lessons

An absent process is one observation inside resource retirement. Acceptance must verify the provider's complete release and saved files before dropping ownership.
