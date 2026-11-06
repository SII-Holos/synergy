# Decision Record: Keep message migrations coherent with prepared projections

Status: implemented

## Problem

Canonical message migrations can run after a display or search projection has already been prepared. Updating only canonical storage leaves cached file-recording quality or tool content versions stale. A summary may then describe complete recording incorrectly or repeatedly request a body using an obsolete version.

## Decision

The file-checkpoint migration publishes changed root headers and new Parts through SessionHistoryDisplay within its existing storage transaction. Tool-input migration invalidates the affected Part page generation and marks its search source dirty atomically with the canonical write. Resumable preparation discards the obsolete cursor before rebuilding from the migrated record. Raw audit artifacts remain unchanged.

The owning [message architecture](../../../architecture/session-and-messages.md#presentation-and-full-history-operations) describes the projection lifecycle. Regressions prepare both caches before migration, execute the migration twice, and assert accurate recording quality and original-content versions afterward.

## Alternatives considered

**Invalidate only in the browser after reconnect.** Server projections are shared by all clients and would still serve stale content or conflicting versions.

**Rebuild every historical body at startup.** This increases startup cost and undermines bounded preparation. Invalidating only changed records preserves lazy rebuilding.

## Consequences

Migration and projection changes commit together, while historical bodies remain lazy. Tests cover warm caches as well as idempotence; changing migration-owned message fields requires auditing all derived projections.
