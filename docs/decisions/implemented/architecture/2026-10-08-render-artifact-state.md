# Decision Record: Session-owned visual artifacts and state

Status: implemented

## Problem

Inline visual results need executable content and durable interaction state without granting generated pages session or host authority. A separate conversation or event model would duplicate existing recovery and history semantics.

## Decision

Media owns the versioned render protocol, immutable source Assets and revision-checked state operations. The portable wire schema lives in Util because Media and UI both consume it. Source Assets are attached to the producing tool Part, so the existing rollout attachment transfer retains evidence through fork and export. Mutable state occupies the independently persisted tool Part metadata, separate from immutable source bytes. Canonical restoration must not re-save identical content through authored control callbacks; the frame deduplicates content before revisioned writes. Scope, completed-call ownership and effective-history checks precede every state operation.

State writes use the existing SQL transaction and Part publication path. Repeated mutation IDs are idempotent; conflicting revisions return current state. Writes never invoke a model. Per-model context contributions refresh bounded semantic state while root-scoped contributors retain their cache behavior. The latest four relevant states fit within a 32 KiB context budget; UI-only state and source HTML are excluded.

Historical static HTML remains inert. Versioned descriptors do not upgrade the execution authority of historical results or arbitrary HTML attachments. The frontend uses one render surface with an explicit source policy.

The shared UI mounts completed content in an opaque, credentialless iframe with a document-bound MessageChannel. Static history runs only the host bootstrap after sanitization. Interactive sources allow HTTPS static resources; connection APIs, forms and child frames remain blocked. Libraries load from separately bundled assets before authored scripts execute. Host theme, locale, dimensions, visibility and reduced-motion state are pushed through the channel. The same component serves inline results and expanded resource previews.

Follow-up requests open a protected host dialog and enter the normal durable Inbox only after confirmation. Confirmation retains a stable message identity for retries and is cancelled when its connection, Scope or session changes. Frame state uses revision-checked saves; expansion flushes pending state before opening the viewer. Source links resolve through their producing call rather than granting a bridge based on MIME. JSON sources mistakenly authored as images retain a usable managed-resource link when image decoding fails.

The same flush operation protects viewer close and HTML export. State observation uses canonical Part updates and revalidates on reconnect or history changes. Annotation capture is optional evidence: a bounded PNG is previewed with the confirmed input, while structural feedback survives canvas tainting and unsupported capture. Animation frame callbacks suspend when a view is inactive; host-owned transitions use the shared motion settings.

## Alternatives considered

**A separate visual database and event stream.** This would require duplicate fork, delete, replay, rollback and import ownership logic. The current Part and Asset boundaries already supply these operations.

**Mutable HTML in tool metadata.** It duplicates large content in synchronization snapshots and erases the source associated with feedback. Immutable source versions retain that association.

**Calling the agent from generated JavaScript.** An untrusted document cannot authorize a session input. The host owns preview and confirmation; confirmed inputs use existing Inbox admission.

## Consequences

Stored state is JSON limited to 16 KiB, not arbitrary JavaScript memory. Revision conflicts require reconciliation rather than silent overwrite. Source retention follows the existing Asset and rollout lifecycle. The generated API shares error and Scope behavior with other Media operations.

Sandbox and message channels follow the [HTML iframe standard](https://html.spec.whatwg.org/multipage/iframe-embed-object.html#attr-iframe-sandbox) and [channel messaging standard](https://html.spec.whatwg.org/multipage/web-messaging.html#channel-messaging). HTTPS resource permission is not an outbound data isolation guarantee: URLs can carry data even when connect-src is disabled.
