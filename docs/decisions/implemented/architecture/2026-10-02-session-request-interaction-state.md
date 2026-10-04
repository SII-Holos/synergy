# Decision Record: Session request interaction and task progress ownership

Status: implemented

## Problem

Question and permission presentation needs to survive Session-page replacement, uncertain replies and navigation without duplicate submission or lost drafts. Progress counts cannot establish that execution has ended, and repeated graph mounting or document-level keyboard handlers make nested interactions unreliable.

## Decision

The directory-level SessionDecisionProvider owns submission, selection and v1 Question drafts. Identity includes server, Scope, session, request and kind; each operation captures its original client and immutable input. GlobalSync owns pending requests and publishes a Scope/generation/revision confirmation only after a successful pending-question snapshot is merged with events. The existing list routes are Scope-local: source-Scope metadata limits each read to its index slice, and sequencing trackers stay per Scope so another runtime epoch cannot discard terminal-event evidence. Draft cleanup uses its own Scope's confirmation or explicit terminal evidence. After reconnect clears the runtime index, successful incremental replay also reloads pending lists when the current generation has no confirmed snapshot; an empty journal cannot establish that a request has ended. Unknown submission results require a state check before sending again. The native page registers an outlet while the host retains a fallback for replacement pages; DataProvider replies share the coordinator.

A single non-modal request card switches requests through a queue menu. Questions use native direct-answer buttons or explicit per-question navigation with one final submission. Custom input is always available. Permissions expose once/reject first and session/persistent matching-rule grants second, with lazy full details and server-owned risk reasons. Broader grants show the actual operation and target patterns, runtime or persistent lifetime, and server-declared operations that still require approval. Todo uses complete read-only rows.

Progress summarizes the selected Todo/DAG view with cancellations excluded from the denominator. Canonical execution activity and transport readiness determine receipt lifetime: confirmed end retains it for 1.6 seconds and fades for 180 ms, including failure and expanded state. Waiting, pause, disconnect and new activity cancel removal. Shared floating positioning provides one anchor-width source and viewport collision handling without hidden measurements; the expanded layer stays above the Composer. The graph instance is retained across collapse and view changes; hidden content is inert and frozen. Node identity retains native controls and focus anchors while controlled Popover details share pointer and keyboard activation. Open nested overlays retain Escape even before autofocus transfers.

## Alternatives considered

**Component-local submission and navigation state.** It cannot coordinate tool-card replies with the host card and loses ownership when Session presentation changes.

**Automatic retransmission after an uncertain reply.** A lost response may have followed successful server execution. Checking pending state keeps retry explicit and avoids repeating a completed decision.

**Cleaning drafts from every empty pending bucket.** Loading, reconnect and stale snapshots produce empty projections without terminal evidence. Snapshot confirmation preserves unread drafts through those intervals.

**Dropping tool-card replies when the pending index is empty.** Reconnect can temporarily empty the index while a card still holds a valid permission identity. Forwarding that identity through the same coordinator preserves the user's action and the existing duplicate and uncertain-result guards.

**Progress shell morphing and remounting graph views.** Dimension observers, measurement mirrors and reconstructed graphs add layout work and discard manual state. A fixed summary and retained inert views keep layout and interaction ownership explicit.

## Consequences

Persisted client data contains question text drafts but no credentials, permission choices or submission locks. Draft storage adds a small scoped versioned entry; server routes, SDK schemas and database state remain unchanged. Suppressing initially ended receipts and hiding failed receipts after confirmed end keeps the Composer clear while durable task facts remain available through server state. The shared Popover gains optional typed content-event forwarding and does not allocate an empty trigger for explicit anchors. Caller-owned close-focus callbacks run before the default restoration and may prevent it, so anchored inspectors and nested settings preserve their distinct focus targets. Product behavior lives in [Web product rules](../../../../apps/web/PRODUCT.md); state ownership lives in [frontend data sync](../../../architecture/frontend-data-sync.md#request-interaction-state).
