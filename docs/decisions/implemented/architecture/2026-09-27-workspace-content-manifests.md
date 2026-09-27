# Decision Record: Persist Workspace bytes through immutable manifests

Status: implemented

## Problem

Disposable compute cannot own the only copy of Workspace files. Object storage provides blobs rather than a POSIX filesystem, and concurrent or interrupted writes need one authoritative content version.

## Decision

Workspace backend selection, local binding and content head are separate catalog fields. Existing directory records receive explicit backend metadata through the central migration runner without changing their authority or history. Object-backed Workspaces select a Runtime-owned blob store. Their immutable manifests preserve bounded file chunks, directory entries, modes and contained links.

Uploads precede publication. The existing Agent Storage transaction compares binding generation, content revision and mount identity, records the immutable revision, and advances the head. A stale writer or failed upload cannot publish a partial tree. Reads and edits of dormant object-backed files need no Environment. An active mount makes the dormant path unavailable so callers cannot silently read an older snapshot.

Materialization verifies every file and chunk in an isolated staging directory and publishes only into an empty destination. Native capture checks source identities and metadata before returning a manifest. The existing atomic file publisher is shared with standalone execution hosts while Workspace claim admission stays with its owner.

Classic and anchored file tools consume a selected file view. The native adapter retains existing physical admission and history hooks; object and mounted views share logical identity, byte-version validation and edit evidence. Range reads retain a full-file content version and reject a changed file between ranges. Permission classification uses the target path namespace and the file host validates actual target symlinks. The controller cannot infer remote containment from its own filesystem.

## Alternatives considered

**Treat S3 and OSS as mounted POSIX filesystems.** Filesystem emulation does not supply equivalent rename, locking and process-write semantics. Compute receives a real materialized filesystem, and persistence uses explicit checkpoints.

**Use mutable object-store keys as the authoritative head.** That creates another transactional owner beside Agent Storage and separates file version publication from execution state. Immutable uploads plus the existing SQL transaction keep one owner.

**Read the saved manifest while an active view is unavailable.** This presents stale data as current and can authorize destructive overwrites. Active view ownership fails closed until reconciliation.

## Consequences

File browsing and search consume the selected view without requiring a native directory projection. Object searches pass verified file bytes to the existing Ripgrep parser rather than create a second filesystem copy or allocate an Environment. Bounded caches retain verified immutable manifests by store and content hash; publishing a different head changes the selected cache entry. Physical live views still bypass dormant content access entirely.

Interrupted uploads may leave unreferenced immutable objects; ordinary operations never delete them. A backend-specific retention process can collect them after proving they are unreferenced. Blob credentials belong to Runtime composition rather than Workspace metadata. Object storage restores file state, not process memory or container root filesystem changes. OSS uses its own official V4 implementation rather than assuming S3 signing compatibility.
