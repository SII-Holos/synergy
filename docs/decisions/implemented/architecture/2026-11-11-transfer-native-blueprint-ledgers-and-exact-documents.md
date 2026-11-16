# Decision Record: Transfer native Blueprint ledgers and exact documents

Status: implemented

## Problem

Session metadata alone cannot preserve Blueprint review ownership, SuperPlan graph history or the exact documents those workflows reference. Reconstructing them from messages can select a newer document, duplicate a reviewer or lose a pending audit intent.

## Decision

Blueprint registers one versioned portability owner for Plan, BlueprintLoop and SuperPlan. It preserves canonical loop and run records, native events, reviewer bindings, stop and audit intent, and the related Session closure. Bounded derived indexes identify the relevant records and Note versions per Session; their owning migration rebuilds references from retained native ledgers. The original records remain authoritative.

Each related Session carries its own proof and transport partition. A native loop or run has one canonical anchor; related Sessions carry verified links. Document snapshots use private owner-and-Session transport keys, then publish through the Note owner, allowing multiple workflows to reference the same immutable version without creating conflicting transport destinations or another Note authority.

Note prepares an immutable per-handoff selection of exact version references. Sealing and retention pins keep authoring edits and deletion from changing the chosen bytes between export and dependency enumeration. Export retains nested unknown metadata. Publication validates complete evidence and exact cross-record dependencies before one paused activation, rejects conflicting destination records and rebuilds derived indexes. It never starts an executor or reviewer.

Native domain mutation guards reuse permanent epoch admission: source draining permits final owner writes, final freezing rejects them, and only the exact aggregate activation transaction can publish destination records. Deadline and observer delivery are drained by the native Blueprint owner; independent Continue and current execution capability govern subsequent work.

## Alternatives considered

**Rebuild workflow state from transcript summaries.** Summaries do not retain native review intent, graph events or exact document versions.

**Copy an entire Scope.** This includes unrelated private documents and leaves unclear lifecycle ownership.

**Let each workflow publish the same canonical Note transport path.** Multiple legitimate references collide during verified staging and duplicate authoring authority.

## Consequences

Indexes and preparation references add bounded metadata work while the native stores retain business state. Missing historical document bytes and unavailable loop sources remain explicit blockers. Real fixtures cover queued Cortex audit children, immutable historical and current documents with unknown nested metadata, Core message preservation and one aggregate paused activation across two isolated Homes.
