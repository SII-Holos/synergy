# Decision Record: Publish native Workspace moves with retained range receipts

Status: implemented

## Problem

Native file capture and ordinary object imports did not own a directory move intent. A captured file closure could not prove a destination CAS, retain the affected range or reconcile an unknown publication. Ordinary exclusive callbacks also released their claims on exit, while token persistence could fail after native admission. A new capture after a lost result could publish a different operation under the original move identity.

## Decision

`WorkspaceMove` is the single data-operation owner for native-to-object moves within one actual Runtime/Store authority. Its immutable request binds the move ID, source and target Workspace/Scope/generation, target path and expected catalog revision, mapping revision, explicit difference-acceptance field and validated ActorStamp supplied by the composing owner. It does not infer authorization from those fields or grant Session execution. This first path copies a complete native tree into an absent object subtree; `acceptedDiffHash` must be null. Existing-directory adoption, other destination kinds and organization cross-Realm transport remain blocked or separate integrations through this owner.

The same intent retains native dispatch, its original claim reference, the final candidate manifest, publication state and the eventual receipt. A derived range index points only to that intent. Dispatch identity includes the actual Runtime/Store configuration and immutable request. A failed native-token commit is recoverable through the same purpose identity in the native coordinator; copied records in another namespace cannot acquire the original claim. Native tokens remain private and are absent from public status.

Local Runtime registers the native SourceHost during Workspace composition. It validates the current native binding, rejects Runtime data and undeclared additional writable locations, and captures under `WorkspaceAccess`. An existing retained exclusive frame supplies its actual parent ownership; ordinary requests acquire their own claim. Durable exclusive claims reuse the existing native coordinator ledger and recovery token. The registered provider returns the original owner and roots, checks their physical identities and only then lets `WorkspaceAccess` create a fresh bounded callback. A replacement directory with equal content cannot borrow that claim. Recovery does not turn a caller label into a Session or Task identity.

Preuploaded immutable objects do not publish a head. Final capture reuses the disk-indexed native portable tree and Git adapter, including supported dirty, untracked, ignored and linked-worktree state. Its complete graph is checked through Archive's original verifier. Full-root import composes indexed references through the same `WorkspaceContent` writer, preserves outside entries and directory/file/link metadata, and retains only missing parent chains. There is no second chunk codec, complete tree Map or alternate business writer.

The target owner reserves the affected subtree before source capture and rejects every active mount state. Canonical content writers carry their derived mutation footprints into the final catalog transaction; overlapping writes reject, while outside changes retain ordinary head CAS semantics. Mount creation, rebinding and retirement check the same retained reservation. Publication rechecks maintenance admission, the expected generation/revision and mount absence, then commits the merged head and immutable move receipt together under original source/target guards. A range reservation does not bypass whole-head CAS: a concurrent outside write is preserved and makes the stale move reject.

The receipt binds the final source manifest and physical binding, old/new target heads, target directory, binding/mount generations, request hash, mapping revision and subtree digest. `receiptHash()` commits that complete receipt; neither its `requestHash` nor the source file manifest can replace the CAS receipt commitment. Prepared validation fully reads the retained subtree and compares its digest while the range remains held.

The intent enters `publishing` before the final transaction. A lost commit reply first reads that original receipt. If no completed receipt can be established, the original range and native claim remain retained; another `run` only reports unresolved publication rather than capturing or publishing again. Explicit inspection and the owning cancellation/retirement path reconcile it. A known receipt releases only the original native claim. Cold retry before publication recovers the same claim and frozen candidate rules; it never invents a replacement directory.

Resource reservation release records a permanent terminal decision from the already authorized composing owner. It does not create or certify a Session activation proof. Cancellation before or after publication releases the preparation hold but leaves source files and published target data intact. Undo or deletion requires a new explicit operation and current CAS. Actor validation, Session pause/freeze/epoch proofs and remote resource authorization retain their existing owners; Main handoff capability is not enabled by this primitive.

## Alternatives considered

**Treat a captured tree hash as the move receipt.** It cannot prove a destination version, atomic subtree merge or reserved range. The complete receipt has a distinct commitment.

**Publish a complete replacement Workspace head.** That would overwrite unrelated files. The canonical indexed writer imports only the selected subtree and keeps whole-head CAS.

**Release an exclusive claim when the source callback returns or fails.** Native admission can precede an uncertain token or publish acknowledgement. The durable claim and same-intent dispatch evidence survive that boundary.

**Restart capture to determine an unknown result.** Another capture is a new observation and can produce new effects. A publishing attempt is only inspected under its original identity.

**Create a parallel handoff coordinator or native recovery ledger.** Session epochs and the native coordinator already own those facts. The move adds one data intent and a derived range index, with original native references inside that intent.

## Consequences

The standalone native-to-object data path has atomic head/receipt publication, stable unknown-outcome inspection, cold native-claim recovery and retained subtree preparation. It uses bounded portable pages and actual immutable graph verification. Pending or published preparations block maintenance until their owning operation settles them. Unpublished immutable objects follow existing storage retention; no automatic GC or source deletion is introduced.

This is one independently verifiable WorkspaceMove unit, not completion of the whole cross-platform or organization handoff plan. Target-existing difference previews/adoption, cross-Realm resource RPCs and controller proof wiring, other destination backends and explicit additional writable mappings still require their owning integration. Supported filename, Git and platform behavior comes from the existing portable owners; their unsupported dependencies remain explicit blockers. Current private authorization and writer-retirement policy are unrelated to a file-copy receipt.

## Verification

Local Runtime's `test/workspace/move.test.ts` moves a real 513-file paged tree after a preupload and intervening source edit, preserves outside files, blocks overlapping ranges and lifecycle changes, and proves cancellation neither deletes source files nor undoes publication. A real active native mount rejects before source capture. A held actual upload exposed publication crossing a maintenance hold; the final admission checks now reject it before target effects. Actual last-write barriers reproduce native-token orphaning and unresolved publication; the final head/receipt rolls back together and subsequent runs do not recapture. A post-COMMIT lost reply reads the same receipt without a second upload.

The same suite reopens the actual Home with a retained original claim, rejects a copied intent in a different native namespace and rejects an equal-content replacement directory at provider recovery. Runtime data and additional writable roots produced real failing cases before their source guards were added. A held native source frame initially reproduced an ownership conflict; final capture now borrows its real parent without releasing it. A linked Git worktree passes through object storage and native materialization after both original repositories are removed, retaining HEAD, staged/unstaged status and ignored files. Existing-destination adoption remains a tested refusal. Focused content, coordinator, claim-maintenance, mount and managed-transfer suites cover adjacent invariants.
