# Decision Record: Reconcile publications after renderer reload

Status: implemented

## Problem

Publication editors retained logical request identities only in component memory. If publication committed but its response was lost, reloading removed that identity. Catalog contents and a sealed upload cannot establish which request committed; blindly starting another request loses the existing publication's idempotency protection. Repeating the write also cannot reconcile after a project becomes read-only.

## Decision

Knowledge and artifact services expose read-only publication receipt operations. The authenticated account supplies the existing receipt namespace; the strict original Publish body must match its retained hash and target. A found receipt resolves its exact immutable version after current object/project read authorization, independently of write permission or source Session visibility. An absent receipt is an observation, not proof of non-dispatch or permission to create another identity. The service adds no receipt table or replay operation.

The Web publication owner stores one versioned IndexedDB metadata record per logical request after upload sealing and before dispatch. The record contains the complete original Space identity, bounded sealed-upload summary, original strict Publish request and its digest. It contains no local files, binary contents, manifests, credentials or reconstructed upload drafts. Queries page one purpose and scope, point reads load one request, and explicit logout removes only that Space's metadata through its index.

Every retry reads the original receipt first. A human can explicitly retry the identical request after a missing observation; neither reload nor absence sends a write automatically. Dispatching records survive interrupted pages as uncertainty. A later attempt known not to have been dispatched cannot erase an earlier unknown attempt. Only an exact returned result or owning receipt confirms publication and removes its recovery metadata. Storage failure before the dispatch checkpoint prevents that write; a failed later status update leaves the existing dispatch checkpoint unresolved.

Editor and recovery requests capture their original Space, scope, source and payload before awaiting. Retirement aborts their storage transactions and UI callbacks; it does not roll back an accepted publication. Readable archived projects can check results while write controls remain unavailable. Confirmed loss clears the rendered private view without deleting unresolved metadata; explicit logout performs that deletion. Publication and catalog readers keep their existing authorization owner.

Logout metadata deletion carries its original connection operation's abort signal through database opening and the actual IndexedDB transaction. A replacement connection generation prevents entry after preceding cleanup awaits, and cancellation aborts already queued deletes before commit. The same Space key in a later login cannot authorize an earlier logout's deletion. Database handles opened after cancellation close without starting a replacement transaction; ordinary logout still deletes only its original Space index.

## Alternatives considered

**Infer success from the latest catalog version or sealed upload.** Neither identifies the original logical request, and a later publication can replace the visible version. Exact owning receipts preserve that distinction.

**Retry publication to discover its result.** Repeating a write requires write authorization and can be confused with new work after reload. A separate read reconciles the immutable result under current read permission.

**Persist selected files or reconstruct a request with a new ID.** Binary caching duplicates content ownership and credential exposure risk; changing identity abandons idempotency. Only already sealed publication metadata is recoverable here, and unsealed file selections remain volatile.

## Consequences

Recovery remains an explicit operation and can stay unresolved after a missing receipt, expiry or access loss. Metadata can remain on disk until an exact result is confirmed or the Space is signed out; it has no lifetime request-count quota. The service remains the sole authority for publication, current access and immutable upload bytes. Read-only receipt tests use real Storage, mounted HTTP and generated clients; Web tests exercise actual IndexedDB and original request lifetimes. Whole-file draft recovery and a durable server notification inbox are separate concerns.
