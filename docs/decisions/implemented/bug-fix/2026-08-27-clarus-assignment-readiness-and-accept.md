# Decision Record: Recover Clarus Project readiness before accepting work

Status: implemented

## Problem

Clarus could deliver a runtime assignment before Synergy had discovered and subscribed to its Project. `ChannelHost` correctly rejected the unowned Project, but the provider had no bounded recovery path, so the assignment stopped before Session creation. The platform also treated tunnel dispatch as distinct from task acceptance, while Synergy had no wire emitted at the point where ownership, preflight, Session binding, and assignment persistence were complete. Event-handler failures lost the original typed error and remote identity context.

## Decision

`clarus.project.membership.accepted` is handled only as a hint to repeat the authoritative active/paused Project list, reconciliation, and correlated active-Project subscriptions. REST reconciliation establishes managed ownership from the authoritative Project snapshot, while the subscription acknowledgement establishes remote readiness. Neither the event nor the Assignment payload grants ownership.

When dispatch raises `ChannelHostProjectNotOwnedError`, the Clarus provider performs one bounded authoritative Project sync and retries the same dispatch once. A second ownership failure is recorded with bounded structured identities and rethrown. The archive and ownership guards remain in `ChannelHost`.

After preflight, Session binding, assignment persistence, and deadline synchronization succeed, the provider sends `clarus.runtime.task.accept` immediately before the first Session wake. The existing Assignment record persists `acceptState`, stable `acceptRequestID`, and `acceptedAt`; old records default to `acceptState: none` without a migration. The request reuses the Assignment event request ID and carries run, Project, Task, subtask, and attempt identity. Correlated acknowledgement bypasses generic in-flight suppression and settles only when the request ID and all five identity fields match. Late acknowledgement may upgrade ambiguous state, while transport failure never regresses acknowledged state. Exact replay validates managed ownership and the bound non-archived Session before bypassing `ChannelHost.dispatch`: acknowledged replay is a full local no-op, live pending replay sends nothing, and ambiguous or orphaned persisted pending replay only resends accept with the same request ID.

## Alternatives considered

**Grant ownership from `membership.accepted` or Assignment `project_id`** — rejected because either payload would become an authorization source outside authoritative Project discovery and subscription, bypassing the existing ownership and archive guards.

**Send task accept as soon as the Assignment event arrives** — rejected because receipt does not prove Project ownership, preflight, Session binding, or durable assignment state; it would report work accepted before Synergy could actually start it.

**Add a general task-accept outbox or explicit migration** — rejected because accept uses the existing Assignment identity and record. Zod defaults preserve old records, while the persisted state and stable request ID provide the required replay behavior without another queue or migration runner entry.

**Make the Holos CLI send task accept or nack** — rejected because `assignment list|show` reads the listener journal, while the listener remains the sole Agent Tunnel owner. A synchronous CLI command would need a prohibited second WebSocket, and journal `sendEvent` cannot prove a correlated accepted response. The Clarus provider already owns the borrowed tunnel and the precise post-binding, pre-wake lifecycle point.

## Consequences

A membership acceptance hint or first unowned Assignment can cause one additional active/paused Project sync and correlated subscriptions. Assignments still fail when authoritative ownership remains absent, and archived Projects remain unavailable. Accept state is durable on the existing Assignment record and settles monotonically from `none` through `pending` or `ambiguous` to `acknowledged`. Exact replay performs no duplicate Session, inbox, preflight, or wake work and only resends an unconfirmed accept when no matching live request remains. No accept outbox, migration, second tunnel, CLI accept command, or alternate ownership path is introduced.
