# Decision Record: Create member Sessions through durable command admission

Status: implemented

## Problem

A service directory reservation does not prove that a member Runtime created a Session. Creation can lose its response before the caller learns the Session ID. Assigning another ID on retry would create duplicates, while requiring the target Session to exist before skipping an unreceived creation would prevent recovery.

## Decision

The online creation request selects an organization project and the caller's own member Runtime, with an optional private title. The service derives the creator, generates one native Session ID and commits its directory reservation, indexes and authorization in the same transaction. The complete digest binds that assigned identity and payload. Offline or failed admission rolls back the reservation.

The Runtime verifies the signed creation and its own member identity. It creates the logical project Scope if absent, preserves an existing mapping and writes the bound native Session, reception sequence and receipt atomically. Creation selects no Workspace or Environment and starts no execution. A Session without the matching receipt cannot be adopted or overwritten. Accepted effects survive restart and cannot recreate a removed Session.

The existing command transport forwards creation and reconciles receipts. An unreceived creation can be explicitly skipped before its Session exists; fresh authorization reuses the same identity. Human lookup by original request ID resolves the caller's retained record and rechecks current Session visibility, so a lost response does not require guessing the generated ID. Title content remains absent from service records.

## Alternatives considered

**Return the directory reservation as successful creation.** This would claim Runtime acceptance before B and leave offline callers with a nonexistent execution object.

**Generate an identity for each retry.** The logical request could create multiple Sessions after response loss. The first assigned identity is retained even when an attempt must be skipped.

**Adopt a matching existing Session.** Identity resemblance cannot establish the original creation's receipt or creator. Missing receipt evidence is a conflict rather than permission to overwrite or import history.

## Consequences

Real SQL tests cover reservation rollback, current roles, own-Runtime selection, concurrent creation, native Scope/Session rollback, identity collision and restart. Cross-domain tests use the generated client and independent stores for offline refusal, lost acknowledgment, ID-only lookup, skip recovery and creation followed by input. An actual resident member Runtime also receives creation over verified WSS and retains accepted input after its HTTP caller aborts.

Execution grants, resource selection, attachments and control operations remain separate integrations. The [organization architecture](../../../architecture/organization.md#online-session-creation) defines the exposed flow and retained metadata.
