# Decision Record: Order native portability owner publication

Status: implemented

## Problem

Preparing one owner can require another owner's staged metadata, while publication needs the opposite order. Workspace preparation consumes canonical staged Core identities. Core publication then requires the mapped native Workspace catalog to exist. Treating both dependencies as one graph would introduce a false cycle, while always publishing Core first fails its actual catalog precondition.

## Decision

Portability contributions separately declare staged read dependencies and `publicationBefore` constraints. Registration captures immutable copies of both collections. `SessionTransferOwners.publicationOrder()` validates the complete selected publication graph, requires every referenced owner to be registered and included, and rejects cycles. Owners declaring this capability require a reader that implements this public contract; silently ignoring unknown contribution fields is insufficient compatibility.

Native staging checks that full graph before receiving content and checks it again on verification, aggregate preparation and target context creation. Publication snapshots its handoff identity and incoming owner/context pairs before awaiting Storage. It validates the complete prepared partitions, then invokes owners in their declared topological order within the existing aggregate activation transaction. Every owner's Session contexts retain their incoming parent-first order. No controller special-cases Workspace owner names or creates another publication authority.

Publication dependencies do not permit arbitrary staged reads. Those still require the separately declared read dependency, exact owner/Session partition and compatible reader. Catalog preparation, filesystem installation and Session activation retain their existing owning boundaries; ordering metadata does not prove final files or physical writer drainage.

## Alternatives considered

**Publish Core first unconditionally.** A destination catalog installed by another owner cannot satisfy Core's active Workspace check afterward.

**Use staged read dependencies as publication order.** The legitimate Workspace-to-Core staged read and Workspace-before-Core publication constraints point in opposite directions.

**Reorder Sessions globally.** An owner can require parent-first aggregate publication even when its position relative to another owner changes.

## Consequences

`test/session/transfer-publication-order.test.ts` reproduces cycle, omitted and uninstalled dependencies that previously admitted a verified empty package. They now fail before object I/O or staging-state publication. A real two-Home source aggregate carries root and child through canonical Core and a native Workspace catalog owner. The target previously failed Core's missing-catalog check; it now publishes both catalog partitions before Core, retaining each owner's parent order and paused activation. Mutating the original registration array cannot change the contract, and reversing the caller's context collection from inside the first owner's asynchronous publication cannot duplicate or reorder the captured plan. This establishes native owner ordering, independently of complete Workspace file transfer.
