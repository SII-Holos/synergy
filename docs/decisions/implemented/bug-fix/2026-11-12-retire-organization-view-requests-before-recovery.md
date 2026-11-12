# Decision Record: Retire organization view requests before recovery

Status: implemented

## Problem

Organization resource editing used the Space's request lifetime after its own form closed. An accepted save could therefore finish after Cancel and close a replacement editor. Catalogs also retained private names, drafts, one-time links and details after confirmed access loss. Checking only the Space signal did not distinguish requests issued before that loss from a later restored view.

## Decision

Resource editors own a local request signal combined with their captured Space signal. Disposal aborts the UI wait, clears its volatile credential and prevents its completion callback from changing another form. This does not assert that an accepted backend mutation was cancelled, and disposal never replays it.

Knowledge, resource, member and artifact catalogs reuse the public organization error classifier. A confirmed authentication, access or binding failure clears the catalog and its private descendants, hides mutation controls, and advances the mounted view's request generation. Every retained asynchronous read or mutation result checks its original generation before changing state. Explicit retry can restore the catalog only through a successful current read. Authentication recovery still belongs to the captured Space owner.

Detail, file-metadata, publication and resource-access components report recognized owner failures to their catalog. Removing that subtree also retires its own request signals and releases previews. Members clear one-time invitation and reset links; a response accepted before the loss cannot overwrite a newer invitation after recovery. Knowledge update receipts remain in their existing owner for explicit reconciliation rather than being erased or replayed when the catalog disappears.

Catalog-owned confirmations close through `useConfirm.closeOwned()`, which addresses only that hook’s registered dialog IDs. Confirmations capture their original view generation, target and revision when opened. A restored view requires a new confirmation. Closed dialogs suppress late completion callbacks and error feedback without closing another owner’s dialog or claiming rollback of an accepted mutation.

Ordinary service failure preserves the mounted editor, draft and readable metadata. Retry progress remains visible outside the discarded private subtree. Session model edits retain the server's exact existing infrastructure selection; a first selection explicitly supplies null workspace and environment references. The infrastructure schema and migration belong to the [resource-selection decision](../architecture/2026-11-12-select-organization-infrastructure-in-one-resource-contract.md).

## Alternatives considered

**Use only the Space signal.** Cancelling a form or losing one view's authority does not necessarily switch accounts. An App fixture reproduced the old completion closing the new editor at both viewport sizes.

**Clear state on every request failure.** The service can be temporarily unavailable while the current user still has authority. Existing 503 fixtures already retained drafts correctly and remain part of the regression.

**Accept an old response after a successful retry.** It can restore private state issued under the previous access observation or replace a later one-time link. A per-view generation retires those results without introducing another authorization source.

**Rely on container disposal to close dialogs.** The catalog survives access recovery while its private descendants disappear. A held list response reproduced confirmation dialogs remaining open after both resource and member catalogs were cleared.

## Consequences

Confirmed owner loss removes private data promptly while transient failure remains recoverable. Requests may have already affected the server, so UI cancellation and local retirement never imply mutation rollback. The App fixture exercises accepted save disposal, four catalog recovery paths, nested metadata/access failures, late invitation delivery, exact infrastructure preservation and confirmation retirement across held responses. Focused shared-dialog fixtures verify exact owner closure, owner reuse and late success/failure after retirement. The [postmortem](../../../postmortem/0118-organization-view-recovery-retained-old-requests.md) records the reproduced failures.
