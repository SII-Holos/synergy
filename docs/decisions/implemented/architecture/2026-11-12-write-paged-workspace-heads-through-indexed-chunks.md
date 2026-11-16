# Decision Record: Write paged Workspace heads through indexed chunks

Status: implemented

## Problem

Paged Workspace readers, archives, snapshots and native materializers accepted saved heads that the default file writer and Snapshot restore rejected through a legacy-only manifest parser. The writer also rebuilt a complete entry array and chunk map for every mutation. Advancing native checkpoint production alone would strand reverse saves and baseline preservation on the same legacy reader.

## Decision

`WorkspaceContent.prepareWrite` and `prepareChange` share one paged producer. The canonical portable index supplies metadata and asynchronous chunk references to `SessionTransferStream.link`. Existing files retain their immutable chunk identities without downloading their bodies. New bytes are uploaded in bounded chunks. Creation retains only the missing parent chain; directory operations enumerate indexed headers and references without rebuilding a complete tree or per-file chunk array. Copy, move and import validate literal link targets at their relocated paths, and import also enforces the original `entry` subtree.

Every preparation captures its selection, bytes, original Runtime/Store/artifact configuration, blob methods and cancellation before asynchronous work. A Buffer is copied as bytes rather than retained through its shared slice. The returned `publish()` closes over the original catalog description and appends the same pure owner check to the actual storage commit. Existing Workspace operation and cloud business receipts invoke it inside their original transaction. Workspace operations snapshot their original identity, generation and signal before waiting on the receipt; accepted-result reads retain their existing replay behavior. Expected entry/content versions, the complete head CAS, sensitive-path checks and write permissions remain enforced by their owning operations.

`WorkspaceContent.withTree` supplies the same callback-bound references for paged and legacy inputs. Both reference and nested chunk iterators reject use after the callback or through a foreign owner. Legacy manifests remain readable and are relinked into the current paged output by the same writer; no second business mutator or eager whole-tree migration is introduced.

Native checkpoint, before-image and managed file-import producers reuse Local Runtime's disk-indexed portable inventory. Checkpoint policy captures the native receipt's bytes, including control and sensitive paths; transfer capture retains its distinct exclusions. Saved-head decoding selects the canonical paged or legacy schema before materialization.

The separately registered public version-one Session transfer remains a native physical export producer. `registerWorkspace` installs its singular Host; the public Session transfer prepare route calls `SessionTransfer.prepare`, which captures that Host into the fixed `synergy-session-transfer` version-one archive with a legacy Workspace tree and chunk list. Its existing 100,000-entry and 64 MiB archive/reference limits remain unchanged. `withWorkspaceClaim` reuses an active cohort claim; ordinary calls still enter the enclosing `WorkspaceAccess.exclusive` under the native coordinator. This API is not historical-only, and this decision does not convert its wire format. The separately declared aggregate portability owners continue using paged transfer streams.

`WorkspaceArchive.copyManifest` validates an immutable raw graph descriptor through the existing complete graph enumeration and full-file verifier. It cannot create an opaque saved selection or publish catalog authority. Mount save and baseline preservation use it for a native checkpoint that is not yet a catalog head, while retaining their original mount, native receipt, target and final transaction guards. The opaque `Saved` selection remains required by `copyObjects` and archive export. Save/preserve support precedes the default checkpoint change; acknowledgement follows complete graph copy and original head publication.

Snapshot restore reads only the requested original headers through `withTree`; it preserves existing selected-file versions, revision behavior and actual restore receipts. File import fixes its original Workspace and operation identity before native capture and adds its pure source check to the original dormant operation's final head/receipt commit. It cannot reselect a later caller Workspace or supply new authority; native effects retain their original receipt and claim owner. Object acceptance checks decode the saved descriptor through the same owner and publish prepared effects through the guarded closure.

## Alternatives considered

**Reconstruct a legacy manifest or raise its limits.** Both retain complete arrays and chunk maps, and unchanged files would still be represented by a separate mutation algorithm.

**Download every existing file into the stream writer.** Immutable indexed chunk references already describe unchanged bytes; rereading them makes a small mutation proportional to all file bodies.

**Treat a native checkpoint as an opaque saved selection.** Its new head has not entered the catalog. A fabricated selection or the old catalog head would validate a different source. The raw graph copier reuses graph verification while leaving publication with the original mount owner.

**Flip checkpoint production before reverse consumers.** Save and baseline preservation would reject the new root or lose graph objects. They must accept and verify the complete graph first.

## Consequences

Default object mutation, native checkpoints and managed imports produce one current paged format; explicit legacy inputs remain readable. Metadata processing is disk-indexed with bounded pages and path-depth parent storage. Existing immutable bodies are trusted by reference during ordinary mutation; complete Archive graph copies still verify every file. Unpublished objects may remain after a failed preparation or CAS, under existing storage retention semantics. No new authority, durable ledger, automatic migration, WorkspaceMove coordinator or active recovery policy is added.

## Verification

`test/workspace/content-producer.test.ts` first reproduced the legacy-parser rejection against a real 513-file saved head. It exercises every mutation and a second multi-page import while the original store refuses all existing body reads, preserves literal links and modes, rejects escaping relocation/import and leaves Environment records absent. A legacy saved tree is relinked without fetching its body. Held actual reads prove input Buffer and selection snapshots; original cancellation and namespace replacement after the real last catalog write roll back the outer receipt transaction.

Local Runtime's `test/workspace-file/restore-paged.test.ts` first reproduced the same parser rejection through actual Snapshot restoration, then restores two selected files from a multi-page head. `test/workspace/mount-paged.test.ts` checkpoints changed native files and a sensitive file, verifies paged before/current roots, saves their complete graphs and survives source-object loss and detach. Actual native capture plus caller selection replacement reproduced a cross-Workspace import; synchronous input replacement before receipt lookup reproduced a cross-Workspace mutation. Both retain their original target after the fix. A source check expiring after the actual last receipt write rolls back both the new head and its business receipt at the real SQL commit. FileHost recovery, portable inventory, managed import, original-provenance restore, content concurrency and S3/OSS acceptance retain their focused suites. `test/workspace/producer-compatibility.test.ts` invokes the actual registered public version-one prepare/export API and verifies its native legacy tree and immutable chunk frame. The [postmortem](../../../postmortem/0136-default-workspace-writer-rejected-paged-heads.md) records the observed failures.
