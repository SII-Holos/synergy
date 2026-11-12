# Decision Record: Publish native Workspace mappings with Session epochs

Status: implemented

## Problem

A complete file source does not establish destination catalogs. Every member's known Core references, final file graph and native preparation must describe the same source closure. Catalogs published during preparation expose partial state; Core published before its catalogs fails current Workspace validation.

## Decision

The `session-workspaces` facade composes source and target hooks into one versioned owner. Its staged dependency is canonical Core, and its explicit publication constraint places Workspace catalogs before Core within the existing epoch transaction. Registration requires the public native publication-order capability.

Target preparation compares every portable reference with Core's structured-reference visitor. Current references require matching final trees and generations. Historical references retain their metadata and history without accessing retired directories. Each frame has an exact member-qualified artifact with its declared checksum and byte count. Inner pages verify paths, kinds, complete content and reachability. Extra references, undeclared artifacts and unreachable frames reject preparation.

A temporary SQLite inventory deduplicates shared metadata and reconstructs the canonical digest with the complete source binding. It must equal the frozen source hash before native destination preparation. Member metadata and Workspace-to-member lookups remain on disk; an active native reader reconstructs one staged context. Bounded pages replace a retained map of all Session metadata. Escaped readers reject before I/O, and accepted reads drain before inventory cleanup.

Current directories use the native target owner's immutable preparation and physical identity. Historical-only references receive unbound catalogs. Mappings expose logical IDs and a prepared digest; native paths and receipts remain private. Each new destination identity begins at generation one. Core retains the original generations in historical records.

The target publication callback holds the exact prepared directories across epoch activation. The publisher checks its prepared binding and manifest inside that activation and carries the native frame and original Storage guard through commit. The epoch's asynchronous callback context ends before the native commit guard; its own transaction retains epoch authorization. Catalogs, native provenance indexes, Core and member epochs commit together, with catalog notifications after commit. Failure retains private preparation and publishes no catalog or Session.

The provenance index recognizes a directory only through its exact activated epoch and current canonical catalog identity. This describes owned files and supplies no execution permission or new physical claim. Target publication can finish with the source Home unavailable because destination staging and native preparation already own every required byte.

## Alternatives considered

**Trust the supplied source hash.** Only independent reconstruction verifies received member partitions and reachable bytes.

**Retain every TargetContext.** Session metadata and unknown fields scale with the entire cohort, including members without files. Disk membership and short-lived readers keep traversal bounded.

**Recheck activation context in the native commit guard.** That callback scope has ended. The native publication frame stays open around the epoch transaction and preserves its independent ownership check.

## Consequences

Preparation performs complete byte and metadata verification with bounded buffers and disk inventories. Canonical unknown Core data remains unchanged. Cloud live-view reuse, resource CAS, existing-target differences, Environment mapping and the complete production controller remain separate owning work.

## Verification

Local Runtime `test/workspace/session-workspaces-transfer.test.ts` uses independent real Homes, native claims, Source preparation and destination staging. It rejects a changed source closure and missing native publication scope, closes the source Home, injects a failure after catalog/Core writes, verifies rollback, then successfully publishes the same preparation. Cold reopening recognizes only the original published native identity. Harness `test/session/workspace-target-graph-lifetime.test.ts` verifies actual binary data inside the callback and no staging I/O from an escaped reader. Source partition, capture-attempt, schema, paged tree and independent Git suites cover their owning invariants.
