# Decision Record: Capture object Workspace snapshots through indexed trees

Status: implemented

## Problem

Object Snapshot capture accepted only the legacy complete Workspace manifest. A valid paged saved head failed before capture, and the consumer's recursive directory traversal depended on complete entry and chunk arrays. Raising that manifest limit would retain the same unbounded representation and duplicate the canonical indexed reader.

## Decision

`Snapshot.trackContent` captures the original Workspace description before asynchronous resolution, then opens the explicitly selected saved head through `WorkspaceContent.withTree`. The callback contains native Snapshot initialization, capture, Git tree construction and durable retention. Canonical reader ownership, original storage ports, cancellation and accepted-I/O drainage retain their existing lifetime.

The tree's `assertCurrent()` exposes only the same pure read-lifetime check already used by its methods. Snapshot rechecks it after initialization, capture, tree options and actual Git tree writes, and before retention. This restricting closure passes through `SnapshotStore.retainCurrent`, its selected persistence owner and the actual stored-Snapshot publication transaction. The final database COMMIT appends it to the original cancellation check; it cannot replace that signal or supply Snapshot authority. A callback-end check alone is too late after a root has committed.

`SnapshotCapture.Content` is the existing indexed tree interface. It directly looks up each directory's `.gitignore` and iterates the canonical ordered immediate-child seek. It does not materialize a complete tree, per-file chunk array or a second index. The Workspace owner supplies both legacy and paged readers; directory traversal does not repeatedly enumerate an entire subtree.

Snapshot policy remains distinct from content graph validation. Nested ignore rules, tracked ignored files, excluded names, literal links, executable modes, entry/depth/time bounds and the 2 MiB per-file policy are preserved. An admitted regular file is fully consumed through the canonical reader, checked against its declared size and complete hash, and passed to the existing native Git object importer. Oversized files remain explicit size omissions without downloading their bodies. Immutable object-store and checksum failures are hard capture errors, even when the caller requests omission reporting. Metadata indexing does not certify the bodies that policy excludes or omits.

The native directory producer and the durable Snapshot format do not change. The existing SnapshotStore retains roots and selected external content; a successful object capture remains readable after the original Workspace objects and disposable Git cache disappear. There is no persisted shape upgrade or alternate recovery path in this consumer change.

An invalid source callback or configuration blocks root publication, including after the transaction's last body write. The manifest, legacy-input fence and preparation removal roll back together. A failed source guard leaves its original unpublished preparation and bytes for explicit owning maintenance rather than attempting cleanup through a substituted context. Commit uncertainty also preserves that evidence. Immutable Git objects may remain without a successful returned root. Native callers that supply no restricting guard retain their existing capture path.

## Alternatives considered

**Reconstruct a legacy complete manifest.** That would duplicate entries and chunk metadata in memory and preserve per-directory full-tree scans.

**Implement another prefix cursor or index in Snapshot.** The Workspace indexed owner already defines path ordering, immediate-child seeks, cancellation and callback lifetime.

**Treat missing immutable bytes as per-file read omissions.** That would publish apparently usable history after a storage or integrity failure. The explicit size policy is the only intentional skipped body in this path.

## Consequences

Both saved-head formats use one capture path with bounded file buffers and canonical metadata seeks. Existing Snapshot capture policy still limits the historical evidence it records; this does not promise that every file in a Workspace is snapshotted or that every graph body was verified. File writing, mount allocation and the default Workspace producer are outside this change.

## Verification

`test/snapshot/paged-content-consumer.test.ts` constructs a real saved head spanning more than one portable metadata page and captures it through native Git plus `storedSnapshots`. It verifies nested ignores, preservation of a previously indexed ignored file across a legacy-to-paged head change, literal links, binary bytes, executable modes and a size omission without reading the oversized object. Removing the complete source object directory and Git cache still permits the Snapshot owner to reconstruct and read the durable root.

The same fixture rejects a missing chunk and individually valid chunks with a wrong complete-file digest without producing a successful root or omission callback. Held reads verify the original Workspace/head snapshot, cancellation and artifact-owner replacement. Existing `content-import` and native `workspace` suites retain object importer failure, concurrency, byte identity, ignore, link, historical read and binding-generation coverage.

Two real publication barriers reproduced late-owner bugs. One holds the result of an actual successful `write-tree`; another changes the artifact configuration after the real stored publication writer has completed its body. Both previously rejected only after retaining a root. The pure pre-retention and final COMMIT checks now leave no canonical retained root, and the latter preserves its original preparation for reconciliation. The [postmortem](../../../postmortem/0125-snapshot-retention-outlived-its-source-reader.md) records the causal evidence.
