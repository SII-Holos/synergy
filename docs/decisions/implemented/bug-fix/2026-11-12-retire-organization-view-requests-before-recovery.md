# Decision Record: Retire organization view requests before recovery

Status: implemented

## Problem

Organization resource editing used the Space's request lifetime after its own form closed. An accepted save could therefore finish after Cancel and close a replacement editor. Catalogs also retained private names, drafts, one-time links and details after confirmed access loss. Checking only the Space signal did not distinguish requests issued before that loss from a later restored view.

## Decision

Resource editors own a local request signal combined with their captured Space signal. Disposal aborts the UI wait, clears its volatile credential and prevents its completion callback from changing another form. This does not assert that an accepted backend mutation was cancelled, and disposal never replays it.

Inline project editors retire each opened form independently of their surviving project view. Member discovery has its own request generation, while project-member and resource-access components capture their original Space and project or resource identity. A changed reactive owner permanently retires that component instance. Resource subject selection advances its generation even when switching back to the same kind, so an account → project → account cycle cannot admit the first account response. Mutation arguments and confirmation revisions are copied before the first await or when the confirmation opens; completion never resolves its target from current controls.

A successful project refresh that removes management permission retires the old request generation, editor and owned confirmations while retaining the service's current readable project. A save already accepted under the former observation can still affect the server, but its late UI result cannot restore old permissions or management controls. This narrower transition does not clear the organization identity or treat readable project content as unauthorized.

Knowledge, resource, member and artifact catalogs reuse the public organization error classifier. A confirmed authentication, access or binding failure clears the catalog and its private descendants, hides mutation controls, and advances the mounted view's request generation. Every retained asynchronous read or mutation result checks its original generation before changing state. Explicit retry can restore the catalog only through a successful current read. Authentication recovery still belongs to the captured Space owner.

Detail, file-metadata, publication and resource-access components report recognized owner failures to their catalog. Removing that subtree also retires its own request signals and releases previews. Members clear one-time invitation and reset links; a response accepted before the loss cannot overwrite a newer invitation after recovery. Knowledge update receipts remain in their existing owner for explicit reconciliation rather than being erased or replayed when the catalog disappears.

Catalog-owned confirmations close through `useConfirm.closeOwned()`, which addresses only that hook’s registered dialog IDs. Confirmations capture their original view generation, target and revision when opened. A restored view requires a new confirmation. Closed dialogs suppress late completion callbacks and error feedback without closing another owner’s dialog or claiming rollback of an accepted mutation.

Ordinary service failure preserves the mounted editor, draft and readable metadata. Retry progress remains visible outside the discarded private subtree. Session model edits retain the server's exact existing infrastructure selection; a first selection explicitly supplies null workspace and environment references. The infrastructure schema and migration belong to the [resource-selection decision](../architecture/2026-11-12-select-organization-infrastructure-in-one-resource-contract.md).

## Alternatives considered

**Use only the Space signal.** Cancelling a form or losing one view's authority does not necessarily switch accounts. An App fixture reproduced the old completion closing the new editor at both viewport sizes.

**Clear state on every request failure.** The service can be temporarily unavailable while the current user still has authority. Existing 503 fixtures already retained drafts correctly and remain part of the regression.

**Accept an old response after a successful retry.** It can restore private state issued under the previous access observation or replace a later one-time link. A per-view generation retires those results without introducing another authorization source.

**Rely on container disposal to close dialogs.** The catalog survives access recovery while its private descendants disappear. A held list response reproduced confirmation dialogs remaining open after both resource and member catalogs were cleared.

**Compare only the current selector value.** Returning to the first kind makes an older read or accepted mutation appear current. A selector generation distinguishes separate visits without changing the server's mutation semantics.

## Consequences

Confirmed owner loss removes private data promptly while transient failure remains recoverable. Requests may have already affected the server, so UI cancellation and local retirement never imply mutation rollback. The App fixture exercises accepted save disposal, four catalog recovery paths, nested metadata/access failures, late invitation delivery, exact infrastructure preservation and confirmation retirement across held responses. Focused shared-dialog fixtures verify exact owner closure, owner reuse and late success/failure after retirement. The [postmortem](../../../postmortem/0118-organization-view-recovery-retained-old-requests.md) records the reproduced failures.

Project fixtures exercise replacement edits, member search replacement, a reactive project changing without disposal, nested denial reaching the actual project, and show-time confirmation revisions. Resource-access fixtures hold both reads and accepted writes across a complete selector cycle. Publication surfaces present one active Publish entry and explanation; explicit opening and cancellation move focus synchronously, while asynchronous completion does not move it.
