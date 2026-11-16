# Decision Record: Acknowledge only original Handoff machine facts

Status: implemented

## Problem

A replayed historical machine fact returned current private Directory metadata after its target lost human read access. See [the postmortem](../../../postmortem/0169-old-handoff-proofs-disclosed-current-private-bindings.md).

## Decision

The proof endpoint returns `FactAcknowledgement`: the original complete Binding, proof purpose and canonical fact hash. New and repeated facts have the same immutable acknowledgement. Existing proof JSON, signing domains and signatures remain valid. Current View reads belong exclusively to the separately authorized human endpoints.

Terminal object Move reconciliation resolves its original complete request through WorkspaceMove and the target catalog's recorded Scope. Replaying a terminal fact does not load a later Session Directory to construct either its response or its release request.

Cancelled native cleanup uses the original Handoff and current authenticated target Runtime owner. Its finite signed cleanup plan includes the original source cancellation proof and the source binding/control snapshot retained at preparation. It can retire the original inactive preparation or inspect that same cleanup slot; it cannot return Views, differences or bodies, issue fresh preparation, allocate compute or authorize execution. Read-only inspection after a lost acknowledgement does not repeat retirement. Ordinary private reads and project execution remain denied after unsharing or project-role revocation. Account or device revocation still requires its separate machine recovery owner.

## Alternatives considered

**Return an old-shaped View with invented current fields.** This preserves misleading semantics and permits callers to mistake receipt history for live authority.

**Add read permission for former targets.** This expands private Session access to repair an unrelated cleanup problem.

**Retry retirement as inspection.** This repeats an effect instead of reading its original receipt.

## Consequences

Generated clients receive an explicit machine acknowledgement rather than a current View. The original target can reconcile its own limited cleanup without recovering private read or execution rights. Fresh and upgraded native records lacking a verifiable original source binding remain blocked; the current Directory cannot fill missing historical authority. See [existing native adoption](../architecture/2026-11-13-adopt-existing-native-workspaces-through-original-handoff-claims.md).
