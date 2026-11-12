# Decision Record: Index portable Workspace metadata before file reads

Status: implemented

## Problem

The complete portability reader verifies every file in sequence. Browsing or reading one saved file through that interface would fetch unrelated bodies, while a second file-tree encoding would duplicate integrity and compatibility rules. Large files also require seeking their chunk references without retaining an entire per-file chunk list.

## Decision

The existing `SessionTransferStream` reader offers an exclusive metadata-indexing mode alongside its complete sequential-verification mode. It verifies the original page chains, unique entry identities, chunk counts, byte totals and root totals into its private SQLite index. Metadata iteration retains one descriptor, while byte reads seek by entry and offset and retain a bounded chunk-reference page. Both modes retain the original validated root, bound blob ports, cancellation and explicit reader lifetime.

`WorkspacePortableTree.open` consumes that index and checks every native metadata record, contained symbolic link and directory parent before returning a file view. Parent validation is independent of input order. Directory and link metadata must carry no content. File descriptors expose their size and digest without exposing a whole chunk array. The view resolves links and reads selected files through the same canonical index.

Metadata indexing leaves complete-content verification false. A byte window verifies each selected chunk; a complete file read additionally checks its file digest at completion. An absent unrelated body does not invalidate an already verified metadata graph. Neither indexing nor a file digest grants native access, changes a Workspace head or supplies a transfer receipt. The composing owner remains responsible for authorization, retention and publication.

## Alternatives considered

**Consume the complete stream to inspect a path.** This makes a metadata operation depend on every body and repeatedly downloads unrelated files.

**Add a cloud-specific manifest.** Parallel tree and chunk codecs would have separate validation and migration behavior. The existing portable graph supplies the required identities and integrity references.

**Keep all entries or chunk references in memory.** This makes residency proportional to a Workspace or its largest file. Private indexed staging bounds residency without imposing a lifetime entry or byte quota.

## Consequences

Metadata indexing requires disk space and work proportional to the graph, and the caller must close the reader. The graph is immutable and does not need a persisted-state migration. The saved Workspace content, archive, mount and move owners still require their own integration; this reader alone does not migrate their active heads.

Tests cross manifest pages without body reads, resolve a directory link, select a single byte window, reject malformed metadata and parents, reject altered content, and preserve the captured window and original cancellation while an actual blob read is held. Existing complete-stream verification remains independently tested.
