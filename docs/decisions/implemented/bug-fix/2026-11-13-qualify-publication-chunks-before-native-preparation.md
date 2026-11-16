# Decision Record: Qualify publication chunks before native preparation

Status: implemented

## Problem

Publication chunk upload prepared native bytes after checking only upload access. Missing files, invalid ranges and conflicting chunk contents were rejected later by the business transaction. Their native preparations had already happened and required disposal and eventual orphan reclamation. A known receipt also entered native preparation on a cold retry.

## Decision

The publication owner qualifies current author access, the declared file range, upload state and original chunk receipt in one read snapshot before preparing bytes. A matching immutable receipt returns its stored progress without preparing or publishing another artifact. A conflicting receipt or invalid target fails before native preparation.

A genuinely new chunk retains the existing prepared binary owner. The same qualification runs again inside the final SQL transaction before publication. A matching receipt committed while preparation was pending is observed without a second publication; revoked access and incompatible current state still reject. The original prepared pin is disposed through its existing lifetime on every outcome.

Receipt observation establishes the original accepted checkpoint rather than repairing or freshly verifying storage. File sealing and content reads retain their existing checksum verification. No receipt format, upload state, native collection policy or public API changes.

## Alternatives considered

**Collect rejected preparations more aggressively.** This creates avoidable native work and does not establish whether a publication request could succeed. Native orphan collection must continue protecting active preparations and references.

**Rely only on the initial snapshot.** Author access, state and receipt ownership can change during native I/O. The actual writer must recheck them in its publication transaction.

**Serialize every upload around preparation.** Existing immutable chunk identities and transactional receipts already resolve concurrent arrival. A new lock would enlarge contention without replacing final authorization.

## Consequences

Rejected chunks and original-receipt retries avoid native preparation. Real Store tests cover cold receipt recovery, conflicting bytes and invalid targets, a concurrent sealed receipt, and revocation while the actual prepared pin is held. This change prevents unnecessary staging work; explicit upload abandonment and version-reference retention remain required before pending publication uploads can be collected. See [the postmortem](../../../postmortem/0159-publication-chunks-prepared-bytes-before-qualification.md).
