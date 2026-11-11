# Decision Record: Declare staged owner read dependencies

Status: implemented

## Problem

A Snapshot manifest can be internally valid while omitting a root referenced by the imported Session. The Snapshot owner needs the core owner's exact root references without accessing unrelated Sessions or duplicating the core record layout. Runtime-local diff revision tokens must also not survive import as usable target cache identities.

## Decision

Portability contributions declare `stagedDependencies` during trusted composition. Registration copies and freezes the declaration. A bound staging context offers a read-only `relatedRecords(ownerID)` port only for those declared dependencies, only when the dependency is present in the verified portable root, and only within the same handoff and Session partition. It verifies record bytes through the existing staging reader. The port exposes neither artifact publication nor owner validation or execution. Reading one dependency does not recursively validate another owner or expand its dependencies.

The core owner exports `snapshotRoots(session, records)` to interpret its own retained records. It validates canonical Session identity before emitting Part roots, rejects foreign ownership and requires one canonical Session record. Snapshot integrations consume this iterator completely and compare every required root with their own validated root inventory; they must not parse core storage paths themselves or treat source counts as sufficient closure evidence.

Canonical Snapshot root inventory also resolves through the versioned retention owner. Native inventory streams exact retained refs and validates their object identity and tree type. The selected stored backend pages only manifest keys, without loading every manifest body or retaining a whole-owner list. Missing ownership yields no roots; cancellation propagates. Legacy or externally selected implementations lacking retained-root enumeration require their owning upgrade or capability instead of silently reporting empty history.

Core import reuses the Snapshot owner's portable message transformation. It invalidates runtime-local diff revisions and their derived values while preserving unknown message and summary fields. No whole-message schema projection may discard another retained owner's fields during this transformation.

## Alternatives considered

**Give every portability owner the whole staged package.** That would erase ownership and member boundaries.

**Let Snapshot parse core keys itself.** Storage layout knowledge would acquire a second owner.

**Trust Snapshot manifest counts.** Counts cannot prove that every reference in core history was declared.

**Copy the old diff token unchanged.** The target cannot use a source Runtime's transient cache identity.

## Consequences

Real temporary staging verifies same-member filtering, independent handoff partitions, rejected undeclared and missing-manifest dependencies, unchanged authority after mutation of the original registration array, and foreign core record rejection. Native and stored inventories exclude another owner's roots and propagate cancellation. A two-Home core import invalidates diff caches while preserving unknown nested data.

These are validation and ownership primitives. Streamed Snapshot preparation, private content installation, complete root comparison, activation and retirement remain the Snapshot transfer adapter's responsibility. This port grants no user authorization or execution authority.
