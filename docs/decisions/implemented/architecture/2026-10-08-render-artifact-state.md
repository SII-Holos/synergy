# Decision Record: Session-owned visual artifacts and state

Status: implemented

## Problem

Inline visual results need executable content and durable interaction state without granting generated pages session or host authority. A separate conversation or event model would duplicate existing recovery and history semantics.

## Decision

Media owns the versioned render protocol, immutable source Assets and revision-checked state operations. The portable wire schema lives in Util because Media and UI both consume it. Source Assets are attached to the producing tool Part, so the existing rollout attachment transfer retains evidence through fork and export. Mutable state occupies the independently persisted tool Part metadata, separate from immutable source bytes. Scope, completed-call ownership and effective-history checks precede every state operation.

State writes use the existing SQL transaction and Part publication path. Repeated mutation IDs are idempotent; conflicting revisions return current state. Writes never invoke a model. Per-model context contributions refresh bounded semantic state while root-scoped contributors retain their cache behavior. The latest four relevant states fit within a 32 KiB context budget; UI-only state and source HTML are excluded.

Historical static HTML remains inert. Versioned descriptors do not upgrade the execution authority of historical results or arbitrary HTML attachments. The frontend uses one render surface with an explicit source policy.

## Alternatives considered

**A separate visual database and event stream.** This would require duplicate fork, delete, replay, rollback and import ownership logic. The current Part and Asset boundaries already supply these operations.

**Mutable HTML in tool metadata.** It duplicates large content in synchronization snapshots and erases the source associated with feedback. Immutable source versions retain that association.

**Calling the agent from generated JavaScript.** An untrusted document cannot authorize a session input. The host owns preview and confirmation; confirmed inputs use existing Inbox admission.

## Consequences

Stored state is JSON limited to 16 KiB, not arbitrary JavaScript memory. Revision conflicts require reconciliation rather than silent overwrite. Source retention follows the existing Asset and rollout lifecycle. The generated API shares error and Scope behavior with other Media operations.

Sandbox and message channels follow the [HTML iframe standard](https://html.spec.whatwg.org/multipage/iframe-embed-object.html#attr-iframe-sandbox) and [channel messaging standard](https://html.spec.whatwg.org/multipage/web-messaging.html#channel-messaging). HTTPS resource permission is not an outbound data isolation guarantee: URLs can carry data even when connect-src is disabled.
