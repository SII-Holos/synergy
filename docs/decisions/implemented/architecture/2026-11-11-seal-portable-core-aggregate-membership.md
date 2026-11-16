# Decision Record: Seal portable Core aggregate membership

Status: implemented

## Problem

A transport can pass every byte checksum after a complete child Session and its owner partitions are omitted. The parent's ordinary Core records do not contain the native child index. Counting the remaining records or checking required owner versions cannot prove a complete aggregate, and a valid set of individual Sessions can still contain foreign parents or disconnected cycles.

## Decision

Portable Core schema 2 includes a transport-only membership node and independently addressable edges for each frozen member. Source capture seals native child-index entries and the Session references declared by its selected native owners. The node binds the handoff, logical Scope, root, canonical parent, selected owner versions and edge counts. Native child entries stream from their owning metadata index; historical Session preparation is not invoked for every child. The source cache lives outside canonical Session records and is reused only for the same frozen binding.

Target Core interprets its own canonical Session metadata. Staging derives the actual owner/member set from its verified partition index, rather than accepting a caller's claimed cohort. A temporary disk graph verifies exact node identities, Scope, parent links, owner partitions and complete edge inventories. Every native child edge must agree with the child's canonical parent, and every non-root member needs its parent's sealed child edge. Owner references must resolve within the same aggregate; they may refer back to a parent or another already included member. A bounded disk frontier then proves that the canonical parent tree reaches every member from one parentless root. Temporary SQL caches are bounded independently of aggregate size and are removed after validation.

Creating a schema-2 root Core target context validates the aggregate before returning that context. Its preparation proof binds the exact verified root hash, Runtime, root Session and Scope. Publication requires that same context and all verified owner partitions inside the existing epoch activation transaction. Membership records are never copied into canonical Session storage. Failed publication leaves canonical membership unpublished; a restarted Runtime validates the persistent package again before obtaining a new context-bound proof.

The native parent membership owner fences additions, moves and deletions in its own write transaction through the existing transfer authority. Source drainage precedes final freezing, so owners can finish their native metadata and parent Inbox writes. Final freezing follows child-to-root order after all owners drain. Schema 1 retains its prior import semantics and remains readable; it cannot establish the schema-2 aggregate proof.

## Alternatives considered

**Compare only manifest member counts.** Removing both a child and its count leaves a self-consistent incomplete package.

**Infer children from parent Session records.** Native membership belongs to an independent index, and workflow owners also declare additional Session dependencies.

**Treat every owner reference as a direct parent edge.** Workflow evidence can refer to a parent or another member. Parent lineage and native owner dependencies require distinct checks.

**Keep a Runtime-wide map of all imported history.** A temporary indexed graph supports complete traversal without retaining every historical member in JavaScript memory or imposing a cohort quota.

## Consequences

A real source with a frozen parent and child produces a checksummed root-only package that the target rejects before returning its Core preparation context. The complete package imports both original IDs in one paused activation and reconstructs native child navigation. Further fixtures reject foreign Scopes, parented roots and disconnected cycles. Native Cortex, Blueprint and Lattice fixtures retain their owner histories under the schema-2 Core composition. Cold incompatibility fixtures use the next unreadable Core schema and still reject body access before reading retained bytes.

This unit proves canonical cohort membership during Kernel preparation and publication. It does not implement the production organization Source controller, command barriers, final Workspace file capture or physical writer drainage. Those callers must negotiate schema 2 for complete aggregate preparation and perform the documented drain-before-freeze sequence; isolated fixture order is not production execution evidence.
