# Decision Record: Export native Workspace closures per Session

Status: implemented

## Problem

Aggregate Session history can refer to current and retired Workspaces, while physical capture must copy only the current working files under their real native owner. A complete file receipt needs every cohort member, including a root without a Workspace, and a destination must independently reconstruct the source closure without receiving private source storage paths or trusting a copied receipt hash.

## Decision

The selected `session-workspaces` owner applies to every Session in its native cohort. Its first freeze performs logical preflight without requiring file capture. Capture runs only through the exact open native physical callback; export requires the frozen source and its retained original capture-attempt proof. Omitting the callback leaves an incomplete held intent that can be explicitly cancelled, without exporting files or starting input.

Capture discovers current and historical identities through Core's canonical structured-reference reader. Historical references retain their logical identity and generation without reading retired directories. Each current Workspace is captured once under its actual generation and native physical claim. The existing paged tree and sanitized Git owners provide file bytes; no alternate manifest or Git protocol is introduced.

The owning native binary store retains bounded content-addressed frames with checksum and byte metadata. Capture traverses the complete inner graph with `SessionTransferStream.open`, verifies all entry content and records only actually reachable frames as exportable objects. A temporary SQLite inventory sorts the canonical metadata without retaining all files or hashes in memory. The shared schema's digest binds the source tuple and sorted member, reference, tree and frame records.

Each member exports its own logical `session_workspaces` partition: one member header, that Session's references and its current Workspace's tree/frame records and binary references. Workspace path segments use a digest of Scope/Workspace identity. A shared current Workspace reuses its immutable capture while exposing separate member-owned references; the source does not copy its entire internal capture branch into every partition. Source handoff paths, internal receipts, cache paths and native directory locations do not enter these records.

The first export verifies the complete metadata closure after final source freeze and a successful original physical attempt, then records a private `closed` hash. Frozen capture reuse requires that matching fact; a frozen incomplete candidate must be cancelled before a new intent captures files. This marker grants no native authority, does not enter the portable digest and is not exported. Every export still checks its actual Runtime, Store, artifact configuration, original signal and current opaque physical proof, including before native iterator advances and after bytes return.

The facade composes source hooks with the independently owned destination hooks. The destination rebuilds the same canonical digest from all verified member partitions, deduplicating shared Workspace metadata and checking their bytes through the inner graph. A source receipt alone cannot authorize publication, resource use, surrender or Continue.

## Alternatives considered

**Copy historical working directories.** Historical structured identity and retained Snapshot graphs supply evidence without granting access to retired physical locations.

**Export the whole source branch for each member.** This mixes member ownership, duplicates unrelated references and exposes internal operation/storage identifiers.

**Reuse any durable candidate once the epoch is frozen.** A failed physical callback can leave candidate bytes before an empty retry freezes the root. The private closed fact distinguishes an actually completed file closure while retaining independent native proof requirements.

**Collect all file records and frame hashes in memory.** File count and directory size are not product quotas. Paged inventories, bounded frames and disk sorting keep the metadata traversal bounded.

## Consequences

Native metadata and binary references remain available across a cold receipt read, but cold data never supplies a physical claim. Draining retries discard candidates and capture again; frozen incomplete attempts fail closed. Source publication remains paused and preserves original input identity. Remote resource ownership, Environment mapping, complete existing-target differences and renewed execution grants require their own owners; this file source does not enable the production handoff capability.

## Verification

`test/session/workspace-portable-schema.test.ts` checks independent metadata reconstruction, ordering, duplicate rejection and binding/Scope qualification. Local Runtime `test/workspace/workspace-source-export.test.ts` uses real temporary files, native claims, Source preparation and canonical Storage. It checks a root without files plus two children sharing one Workspace, independently recomputed closure, historical generations without retired directory access, omitted-callback cancellation, actual recapture after failed final validation and refusal to promote a failed candidate through an empty retry. Physical-attempt, paged-tree, Git and cancellation suites remain owning neighbors.
