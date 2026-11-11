# Decision Record: Materialize independent Git Workspaces for native transfer

Status: implemented

## Problem

A linked worktree's `.git` file points outside its working directory. Copying that file leaves the destination dependent on the original checkout and shared object database. Copying the complete Git administration directory would also transfer executable hooks, credential configuration, remote endpoints and unrelated worktree state. Working files alone cannot preserve the staged index or original history.

## Decision

Local Runtime's `NativePortableGit` discovers the canonical working root, selected Git directory and common directory. Discovery fixes those paths and its Runtime in private evidence. A selected subdirectory cannot silently expand into its parent repository. These native paths are private dependencies for the physical owner; discovering them does not grant exclusion over another checkout.

Preparation creates a private sanitized view of the selected Git metadata. It streams refs, packed refs, HEAD, index, attributes and configuration inspection copies through a disk-backed, sorted inventory. Configuration values are read without includes. Only a finite set of safe core settings reaches the destination. No complete ref or object list accumulates in memory. Preparation and final verification compare the actual captured metadata with discovery's content and native file identities, including working-tree attribute files.

Immutable object files are pinned into the private view by native hard links; cross-volume copies use bounded reads that reject symlink substitution. The view never shares the source's `objects/info` directory, so a newly added alternates file cannot redirect a Git read to an undeclared store. The canonical public `SnapshotGit.importObjects()` imports the complete streamed object inventory, including dangling objects, into an independent repository. Git validates object integrity through its native implementation. The adapter does not implement a second pack format.

The resulting `.git` preserves all native refs, symbolic refs, selected HEAD and raw staged index. The paged Workspace tree owner captures dirty, untracked and ignored working files and substitutes this prepared directory for the top-level `.git` pointer. It calls the prepared verifier after all tree writes, before irreversible handoff facts. Git preparation changes no source refs, index, configuration or working files.

The destination omits source configuration, remotes, helpers, hooks, reflogs and FETCH_HEAD. Reflog and fetch text can contain operational endpoints; this is a metadata projection, not a lossless copy of the original administration directory. Local hook and fsmonitor execution and implicit signing are disabled. The receiving user configures their identity explicitly.

Submodules, LFS/filter dependencies, external alternates, unfinished operations and unsupported Git storage or index modes fail with a fixed `missing.kind` before surrender. They never degrade into a working-file-only copy. Metadata directory links and changed canonical directory identities cannot retarget reads. Cancellation retains its original signal. Prepared verification rejects foreign Runtime use, overlapping checks and calls after disposal; disposal drains an accepted check before removing its private files. Failed removal remains retryable without reopening verification.

## Alternatives considered

**Copy the linked `.git` pointer.** The target stops working when the source or common directory disappears.

**Copy all Git administration files.** This carries credentials and executable configuration and retains unrelated worktree bindings.

**Clone the current branch only.** Reachable history alone misses other refs, staged objects and dangling original objects.

**Expose the original objects directory through a symbolic link.** Later alternates changes can redirect reads outside the captured dependency inventory.

## Consequences

Preparation uses temporary disk, native Git processes and repeated metadata validation. Unsupported repositories remain available at their source and require a supported dependency strategy before transfer. Object pins retain immutable bytes through concurrent collection; they are removed after the independent pack is complete.

Real linked-worktree fixtures delete both the source working directory and common repository, then verify refs, symbolic and per-worktree refs, HEAD, raw index, staged and unstaged diffs, dangling objects and independent commits. Separate fixtures cover detached and unborn HEAD, external metadata changes, unsupported dependencies, original-source preservation, metadata directory aliases and verifier disposal. A cross-volume native error exercises bounded object copying; failed private cleanup retries after the original error. A configured global reference hook executes in the positive control and stays inactive during capture and restored commits. These fixtures do not establish the complete organization handoff or cross-platform matrix.

## Related

- [Git repository layout](https://git-scm.com/docs/gitrepository-layout)
- [Native Workspace ownership](../../../architecture/workspace-and-files.md)
- [Paused Session transfer](../../../architecture/session-transfer.md)
