# Decision Record: Stage streamed Snapshot history before epoch activation

Status: implemented

## Problem

Portable Session records can name historical Snapshot roots whose Git objects are absent from the destination. A transport checksum proves the transferred bytes, but cannot prove a complete Git graph or that every root named by Core was included. Publishing destination Session retention during preparation would grant access before the ownership transaction and leave that access behind after a failed commit.

## Decision

The explicitly registered `SessionTransferSnapshots` owner captures and validates Snapshot history alongside the existing Core partition. Frozen source capture enumerates canonical retained roots and Snapshot parts into a disk-backed identity index. It verifies ownership and tree identities in bounded batches, then imports those roots into an independent Git repository through the existing disk-backed Snapshot catalog. Shared objects are deduplicated across batches. Immutable pack files stream into private artifact aliases with byte lengths and SHA-256 checksums before the source manifest is sealed. A restart exports the same sealed capture rather than reading a changing source graph.

Target preparation requires the exact current destination reservation. The owner's declared Core dependency exposes read-only, same-member iteration and exact record lookup; Core interprets its own canonical metadata and Snapshot parts regardless of their physical export order. Every required Core root must appear in the Snapshot inventory. Each pack is length/hash verified and indexed in an independent repository, followed by native Git integrity verification. Existing target objects cannot satisfy missing source dependencies. The destination imports verified roots under a private version-3 retention identity and confirms native Snapshot reads before issuing a Runtime-bound preparation proof.

Git content installation precedes Session activation. Under the exact epoch activation transaction, the Snapshot owner adopts the verified private retention identity and removes its temporary owner record alongside Core publication. The retained Git refs do not move. SQL rollback restores the prior ownership records and leaves the Session inaccessible. A restarted Runtime rebuilds its preparation proof from verified staging; persisted prepared metadata alone cannot publish ownership. This uses the [single retention authority](2026-11-11-version-snapshot-retention-authority.md), rather than introducing another read path.

Preparation and retirement serialize on the same handoff/member lock. Preparation rechecks the reservation in the transaction that seals its prepared state. Permanent `never_activate` evidence authorizes idempotent private-owner deletion and prevents a delayed preparation from resurrecting it. Permanent source cancellation authorizes removal of only that capture's transport aliases, preserving canonical source history. Snapshot leases precede artifact preparation, matching the operator checkpoint lock order.

## Alternatives considered

**Copy the source repository or trust the target pool.** A repository copy includes unrelated retained histories, and target objects can hide an incomplete source package. Selective import into independent repositories verifies the transferred closure.

**Treat checksummed pack bytes as sufficient preparation.** Arbitrary or incomplete Git packs can have valid transport hashes. Native indexing, integrity checks and Core-root comparison remain required.

**Move refs into the real Session before SQL activation.** Those refs could outlive an aborted transaction and grant premature ownership. An immutable private identity lets one SQL owner remain authoritative.

**Have Snapshot decode Core's private record layout.** Declared read ports and a Core-owned iterator preserve native schema ownership without recursive validation or cross-member reads.

## Consequences

Real two-Home fixtures verify source restart, source cancellation, native destination reads, a missing Core root, checksummed invalid pack bytes, SQL activation rollback, paused activation, stored-backend retirement, lost volatile proof after restart and preparation racing permanent retirement. Pack bodies and root indexes are streamed or paged; the transport imposes no aggregate Snapshot byte or root quota. Temporary Git repositories are removed after each attempt.

Surrendered source transport aliases and replaced retention identities remain conservatively pinned until an owning reconciliation can prove they are unused. This owner does not register a production signed-handoff controller, freeze Workspace writers, supply organization Asset provenance or prove complete aggregate child membership. Those independent requirements remain necessary before a Runtime can claim a complete handoff.
