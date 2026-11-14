# Decision Record: Validate the attached Runtime Scope union

Status: implemented

## Problem

The attached CLI validated the current Scope as a project even though the existing server response and generated SDK also allow Home. A valid Home response failed before the remote command could continue. Direct project-only and child-process tests did not exercise this adapter with Home metadata.

## Decision

The remote adapter validates current Scope metadata with `Scope.Runtime`, matching the server and Local Runtime client. Other reply schemas, generated SDK calls, selected Scope and directory headers, authentication, structured errors and event cancellation retain their existing owners. No server schema or persisted state changes.

## Alternatives considered

**Keep the project-only schema.** It rejects an explicitly supported response and makes attached and local clients disagree.

**Return unvalidated SDK data.** Runtime validation still needs to reject malformed successful replies; the existing canonical union already defines both supported cases.

## Consequences

Attached Home commands receive the same Scope kind as local commands. The real HTTP adapter regression covers canonical Home metadata, mutation addressing, invalid replies, structured cancellation errors and actual event-stream cancellation. Installed command acceptance remains separate. See the [incident](../../../postmortem/0200-attached-client-rejected-canonical-home-scope.md).
