# Decision Record: Establish the organization shared synchronization ledger

Status: implemented

## Problem

Shared Sessions need a service-owned authorization and sequencing boundary before a member Runtime can export local state. A stale exporter must not publish into a newly revoked or re-shared Session, and the organization database must not become a transcript or local-path mirror.

## Decision

The organization protocol defines strict share-change, generation, checkpoint, batch and safe-event DTOs. The service stores a versioned per-generation checkpoint, batch idempotency marker and event projection. Creator-only share and revoke mutations use an exact generation compare-and-set, update the Session directory and private/shared visibility indexes in one transaction, and create a fresh generation state. Handoff blocks both mutations; revoke also requires the current driver Runtime to belong to the creator.

Each export batch binds the Session/project, binding epoch, share generation, contiguous sequence range and SHA-256 payload digest. The service rechecks current authorization and directory metadata, rejects stale generations or bindings, writes all event projections plus the batch marker and advances the checkpoint atomically. An exact duplicate returns the committed checkpoint; gaps and conflicting overlaps return a revision conflict without advancing it. Event reads authorize through the current shared Session and use bounded cursors. Projections contain only safe Session metadata, bounded summaries, integrity digests and attachment descriptors.

## Alternatives considered

**A Runtime-owned share flag** would let an offline or stale member decide who can read a Session, so it could not fence revocation or enforce project membership centrally.

**Direct transcript replication** would copy local bodies and paths into the organization service, violating the metadata-only boundary and making local storage semantics part of the service API.

**Last-write-wins batches** would hide dropped or reordered exports and could overwrite a later generation, so it could not provide a recoverable checkpoint or audit trail.

## Consequences

The service now has a reviewable foundation for shared projections, generation fencing, pagination and replay-safe export acknowledgments. The Runtime exporter, attachment/blob chunks, search indexes and reconnect/drain state still need to consume this ledger. Permanent asset URLs, arbitrary payloads and private Session bodies remain outside the organization storage contract.
