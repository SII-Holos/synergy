# Decision Record: Recover Clarus Project readiness before accepting work

Status: implemented

## Problem

Clarus could deliver a runtime assignment before Synergy had discovered and subscribed to its Project. `ChannelHost` correctly rejected the unowned Project, but the provider had no bounded recovery path, so the assignment stopped before Session creation. The platform also treated tunnel dispatch as distinct from task acceptance, while Synergy had no wire emitted at the point where ownership, preflight, Session binding, and assignment persistence were complete. Event-handler failures lost the original typed error and remote identity context.

## Decision

`clarus.project.membership.accepted` is handled only as a hint to repeat the authoritative active/paused Project list, reconciliation, and correlated active-Project subscriptions. REST reconciliation establishes managed ownership from the authoritative Project snapshot, while the subscription acknowledgement establishes remote readiness. Neither the event nor the Assignment payload grants ownership.

When dispatch raises `ChannelHostProjectNotOwnedError`, the Clarus provider performs one bounded authoritative Project sync and retries the same dispatch once. A second ownership failure is recorded with bounded structured identities and rethrown. The archive and ownership guards remain in `ChannelHost`.

After preflight, Session binding, assignment persistence, and deadline synchronization succeed, the provider sends `clarus.runtime.task.accept` immediately before the first Session wake. The request carries run, Project, Task, subtask, and attempt identity and reuses the Assignment event request ID. The provider synchronously obtains the tunnel request handle but does not await the acknowledgement before waking. The correlated request promise validates all five identity fields and treats `accepted_at` as authoritative evidence. Transport uncertainty records a bounded durable `ambiguous` Channel diagnostic. During one live connection, exact replay creates no second Session or inbox delivery, does not repeat preflight or first-work wake, and resends only while no correlated acknowledgement has been observed.

## Alternatives considered

**Grant ownership from `membership.accepted` or Assignment `project_id`** — rejected because either payload would become an authorization source outside authoritative Project discovery and subscription, bypassing the existing ownership and archive guards.

**Send task accept as soon as the Assignment event arrives** — rejected because receipt does not prove Project ownership, preflight, Session binding, or durable assignment state; it would report work accepted before Synergy could actually start it.

**Persist task accept in Assignment state or a new general outbox** — rejected because the platform wire is idempotent, local work must not wait for acknowledgement, and exact Assignment replay already provides the bounded retry opportunity. Correlated acknowledgement is remembered only for the live connection; transport uncertainty belongs in durable Channel diagnostics rather than a second delivery state machine.

**Make the Holos CLI send task accept or nack** — rejected because `assignment list|show` reads the listener journal, while the listener remains the sole Agent Tunnel owner. A synchronous CLI command would need a prohibited second WebSocket, and journal `sendEvent` cannot prove a correlated accepted response. The Clarus provider already owns the borrowed tunnel and the precise post-binding, pre-wake lifecycle point.

## Consequences

A membership acceptance hint or first unowned Assignment can cause one additional active/paused Project sync and correlated subscriptions. Assignments still fail when authoritative ownership remains absent, and archived Projects remain unavailable. Accept uncertainty is recorded as a bounded durable `ambiguous` Channel diagnostic; during the live connection, exact replay may resend only while no correlated acknowledgement has been observed. No Assignment accept-state migration, generic accept outbox, second tunnel, CLI accept command, or alternate ownership path is introduced.
