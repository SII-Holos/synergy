# Decision Record: Resume Home upgrades through original maintenance owners

Status: implemented

## Problem

A reader upgrade can leave its original maintenance hold after a process exits. A new Runtime cannot reuse the old in-memory lease, and a target marker alone proves neither the original native source nor completed writer drainage. Retirement and restoration capabilities have different purposes and cannot release an ordinary upgrade.

## Decision

`RuntimeMaintenance` registers one required native Home upgrade owner during composition. The dedicated `organization-home-upgrade` purpose persists a version-two operation with its original native witness before maintenance begins. That witness binds the complete source and target reader markers, physical Home, primary options, artifact directory, namespace, signing identity and owner version. The original operation, Runtime, request and cohort remain immutable identities. Backup and restoration retain their version-one representation; an old hold without a witness is not converted into an upgrade.

Cold recovery accepts a request identifier only as a locator. The Kernel reads the original operation and request, verifies its witness against the registered native owner and current process lock, and creates a callback-bound private lease. A draining operation obtains a genuine drainage receipt before freezing. Frozen and releasing operations require their respective native reconciliation hooks; releasing is never represented as frozen. A released operation still requires actual owner inspection before reopening.

The recovered lease retains the complete expected operation. Only the Kernel's own exact compare-and-swap transitions can advance that expectation. A lost commit acknowledgement accepts only the original or exactly intended row. Another row, changed cohort, replaced primary, missing original drainage or retired source remains blocked. The lease expires when its callback ends.

Workspace operations, mounts and Environment inventories share the Kernel's original native reconciliation assertion. It accepts the actual Home-upgrade binding in its exact phase, an actual version-three Source-preparation binding only while frozen, or the original frozen retirement-source capability issued from its verified durable Reference. It grants no release or retirement authority to Source preparation. Complete canonical inventories and the post-inspection operation check remain mandatory; an ordinary backup lease or copied metadata cannot select this path. See the [cold inventory postmortem](../../../postmortem/0187-cold-inventory-assumed-home-upgrade-purpose.md).

## Alternatives considered

**Create another operation or replace the source Runtime identity.** This loses the continuity of the original maintenance decision and can strand its holds.

**Borrow retirement recovery or accept the target marker as authority.** Neither establishes a releasable ordinary operation or current physical writer evidence.

**Release a hold after every failure.** A target write or migration receipt can remain uncertain. The original hold must survive until its native owner reconciles the same operation.

## Consequences

This mechanism supports ordinary format-two Homes with a writable SQLite primary and local artifacts. Other storage and restoration formats require their owning native verification. The Kernel primitive does not supply a Service upgrade, central migration completion, public command readiness or permission to execute Agents. Those domain owners must verify the actual selected target and completed receipts separately. Focused storage tests cover original operation continuity, real phase changes, unknown acknowledgements, changed native ownership and exclusion of legacy backup and retirement holds.
