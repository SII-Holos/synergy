# Decision Record: Export paged Workspace archives through exact object closure

Status: implemented

## Problem

The saved Workspace archive reader required a complete array manifest and rejected valid paged heads. Expanding the paged graph into arrays would restore the metadata limits that the portable representation removes. Reusing existing destination objects during import could also conceal an incomplete archive.

## Decision

`WorkspaceArchive` uses a version-two NDJSON manifest containing the existing `WorkspacePortableTree.Root`, followed by deduplicated checksum-addressed objects and the canonical descriptor's required completion digest. The canonical stream reader indexes distinct metadata pages and referenced body hashes and sizes on disk. Its metadata-only object enumeration does not claim that file bodies are verified.

Export owns the paged reader until its async generator closes. It verifies each emitted object and consumes every complete file before emitting completion. Import indexes received objects on disk, rejects duplicate or trailing frames, and limits incoming object count and bytes by the declared graph's maximum possible closure. Its verifying reader can access only objects actually received from this archive. It checks exact referenced membership, object sizes and whole-file digests before publishing a new catalog identity. An existing destination object cannot satisfy a missing archive frame.

The original Runtime, primary Store options, artifact configuration, blob methods and cancellation remain captured across awaited work. Final catalog creation and head publication share a transaction with the original owner as its commit guard. Saved export selections are opaque originals; copied descriptors cannot authorize export. Cancelled reads reject before late metadata parsing or body emission. Private indexes are disposed on successful, failed and cancelled operations.

Bounded historical array heads retain the version-one archive codec. This consumer addition does not change current Workspace writers or claim that their physical migration, mounts or WorkspaceMove are complete.

## Alternatives considered

**Expand portable trees into one array manifest.** Metadata and chunk-reference memory would scale with the complete graph, restoring the previous limit.

**Treat any existing destination object as received.** A truncated archive could appear complete only because of unrelated target contents, so it would fail independent restoration.

**Add an archive-specific paged tree.** The canonical portable codec already verifies path, parent, kind, page and chunk metadata; a second representation would duplicate those invariants.

## Consequences

Paged saved versions can be exported and independently restored after source loss without complete in-memory inventories. Full-file verification reads body objects after closure transfer, adding I/O while preserving the existing complete-file integrity guarantee. Failed imports may retain immutable unreferenced objects but cannot publish a partial Workspace. Current writer migration remains a separate owning change.

## Verification

`test/workspace/archive-paged.test.ts` exercises a multi-page tree with directories, shared bodies and a contained link, deletes the source, and reads the new target. It rejects missing, duplicate, extra and trailing objects, missing completion, misleading preexisting target objects, a wrong complete-file digest and Runtime/storage substitution. Empty-tree bounds reject objects before writing them. Held body reads exercise cancellation for both archive formats; the array export first yielded one late frame before the cancellation check was corrected.

`test/session/transfer-stream-index.test.ts` covers the canonical disk index and held metadata cancellation. A late invalid metadata response first replaced the original abort reason with a checksum error; the reader now checks cancellation before decoding or indexing it. Existing array archives and portable tree validation remain covered by their owning suites.
