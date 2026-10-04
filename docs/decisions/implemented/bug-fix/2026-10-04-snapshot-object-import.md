# Decision Record: Stream large snapshot imports into the retained object store

Status: implemented

## Problem

Full Workspace baselines block execution admission while Git writes thousands of independently synchronized loose objects. Batching paths into `hash-object` reduces process launches but still performs one durable object write per file. New sessions also resend contents already present in their Scope store, and deep directory trees repeat expensive object synchronization during `write-tree`. The capture cannot trade complete bytes or historical restoration for a shorter preparation phase.

## Decision

Capture retains native identity checks, exact bytes, ignore policy and independent session/Workspace-generation indexes. Its sixteen readers share a 32 MiB payload admission budget with pending blobs. Before writing, bounded `cat-file --batch-check` batches verify unknown hashes against the Scope store, including object type and size. Reuse is operation-local under the existing shared Scope lease; no filesystem timestamp cache becomes content authority.

At most 64 new objects with less than 16 MiB of content use the existing filter-free loose-object path. Larger captures stream verified binary bytes into one blob-only `fast-import` process, with compression level three, zero delta depth, a 64 MiB pack limit and unpacking disabled. Output acknowledgements are drained concurrently and checked against captured identities. Import completion precedes index updates, tree creation and retained-reference publication. Cancellation drains the actual child before releasing operation ownership. Store failures remain capture failures rather than per-file read omissions.

Large importers acquire a process-safe repository writer lock before spawning, recheck object presence after admission and retain ownership until the child drains. Git uses an exclusive checksum-named temporary keep file, so identical simultaneous imports can collide even though ordinary loose writes are safe. The lock covers large imports rather than entire captures; scans, ordinary reads, small writes and independent repositories retain their concurrency.

On positively identified local APFS devices with Git 2.36 or later, `write-tree` alone uses Git's batch synchronization method. Runtime-owned capability caches match mount metadata through physical device identity, including macOS firmlinks. Unknown filesystems and other platforms retain ordinary synchronization. Repository object, pack-metadata and reference synchronization settings remain unchanged. Existing version-two SHA-1 stores and retention refs require no migration.

Capture metrics distinguish read, hash, lookup, write, finalization, enumeration and index work, carry Scope/session attribution and report bytes, reuse and buffer admission. Track metrics add lock wait, initialization, tree, retention and total preparation without redefining the existing track timing boundary. The opt-in fixture benchmark reports full capture latency, logical cold versus warm stores, failures, parent CPU/RSS and object storage; it is excluded from normal CI execution.

The authoritative protocol and synchronization provenance lives beside `SnapshotGit.blobWriter` and `SnapshotDurability.treeOptions`. Current invariants live in [Workspace and files](../../../architecture/workspace-and-files.md#snapshots-rollback-and-restore). This extends the bounded-read decision in [session interaction latency](2026-10-03-session-interaction-latency.md); its input recovery, usage and Library decisions remain applicable.

## Alternatives considered

**Batch `hash-object` more aggressively.** Its path loop still synchronizes each loose object, so larger input batches do not remove the dominant persistence cost.

**Disable synchronization or return before baseline completion.** This weakens durable restoration or admits model execution against an incomplete baseline. Capture remains a completed, retained boundary.

**Always create packs or let Git unpack small imports.** Packing every tiny edit accumulates small packs; automatic unpacking can introduce a child process beyond the importer's cancellation boundary. The explicit hybrid avoids both.

**Use mtimes, watchers, a seeded Git HEAD or object alternates.** These can miss same-size external edits, pre-existing dirty content or portable standalone retention. Verified bytes and the Scope-owned store remain authoritative.

## Consequences

Cold baselines use fewer durable filesystem operations and new sessions reuse retained content. Read/hash cost still scales with eligible Workspace bytes, and highly compressible fixtures differ from real source trees. Packs may split at the configured size and accumulate across large edits; existing offline maintenance owns reclamation. Zero delta depth favors predictable capture/read cost over the smallest possible archive. Local benchmark results describe logical object-store cache state, not a purged operating-system cache or a universal latency guarantee.
