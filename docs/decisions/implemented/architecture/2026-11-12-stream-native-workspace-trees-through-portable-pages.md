# Decision Record: Stream native Workspace trees through portable pages

Status: implemented

## Problem

The older native Workspace transfer builds a complete file and chunk manifest in memory and imposes collection limits. The organization handoff requires complete current files without making memory proportional to the directory or largest file. A changed directory must not cause unrelated bytes to be exported before capture reports its conflict.

## Decision

`WorkspacePortableTree` defines bounded native entry metadata and a versioned root over the existing `SessionTransferStream` page and chunk protocol. `NativeWorkspacePortableTree` inventories paths, metadata and native identities in a private disk index. Directory traversal uses an open directory iterator; file reads and retained objects use bounded chunks. Neither file count nor aggregate file size has a product quota.

Capture validates the complete inventory before its first object write and after its final page. Each original file descriptor also checks its recorded native identity around reading. Links remain internal relative links, special files fail explicitly, and the existing sensitive-path policy blocks credential candidates before content export. Cache placement is checked through canonical ancestors before creating directories, so rejection cannot mutate the source tree. Git metadata requires its separate adapter rather than exporting configuration, hooks or external pointers as ordinary files.

Restoration consumes verified stream entries into an unpublished private directory. A disk index rejects duplicate and filesystem-equivalent paths and requires real directory parents. A private probe measures the target filesystem's case and Unicode equivalence; Windows-unrepresentable paths fail explicitly. Native link targets, file and directory mode bits, and exact bytes are retained. Portable symbolic links use mode `0777`, which Linux supplies natively and Darwin restores with `lchmod` without following the link. Capture keeps the original native identity checks and never changes source link permissions. Bounded-manifest references use the same portable mode when producing new pages, without changing their retained manifest bytes or hashes. Every content stream must verify fully before the empty destination is rechecked and published. Cancellation, corrupt bytes and changed destinations retain no partially published file tree.

These primitives confer no Workspace, Session, native claim or execution authority. Their composing owner must retain the exact physical claim, version and publication receipt. They do not yet install the organization aggregate Workspace owner or complete Git and resource mappings.

## Alternatives considered

**Increase the old manifest limits.** This retains whole-tree and per-file chunk collections and merely moves the failure threshold.

**Validate only after upload.** A parent replaced during enumeration can expose outside bytes before the final conflict is reported.

**Reuse a saved object head for a live native directory.** That head does not establish the actual current file view.

**Preserve arbitrary symbolic-link permission bits.** Linux ordinary symbolic links have fixed `0777` permissions. Retaining Darwin's source bits in portable metadata makes a correctly restored link fail the complete tree checksum. The new paged version-one format uses one portable mode rather than weakening verification or introducing a second receipt format.

## Consequences

Capture and restoration use disk space and index work proportional to their inventory while memory retains fixed pages and the current file buffer. Failed captures can leave unreferenced immutable objects for their composing owner's reconciliation; they never return a completed root. The caller owns storage admission, physical exclusion and durable retention.

Real filesystem tests restore after source deletion, cross manifest pages, preserve binary bytes, names, links and modes, reject source changes and escaping links, and refuse corrupt or cancelled publication. A Darwin roundtrip changes the source link's actual mode, preserves its source and referent, restores a canonical link and verifies the complete tree; changed file permissions or link targets still reject. Bounded references preserve their original header while producing canonical portable metadata. Two concrete counterexamples verify that cache overlap causes no source writes and replaced parent directories export no outside content.

## Related

- [Native source claims](2026-11-12-bind-native-source-claims-to-exact-session-cohorts.md)
- [Streamed Session portability](../../../architecture/session-transfer.md)
