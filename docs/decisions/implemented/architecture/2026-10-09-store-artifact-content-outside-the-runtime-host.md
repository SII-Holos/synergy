# Decision Record: Store artifact content outside the Runtime Host

Status: implemented

## Problem

A PostgreSQL record namespace can survive its Runtime Host while its binary references still point at local pack files. Database recovery alone cannot recover those bytes. Object upload and reference publication also have separate failure boundaries, so collection cannot infer that an unreferenced object is safe to delete immediately.

## Decision

An explicit `Storage.Handle.artifactObjects` selects immutable object artifacts. The backend uses a dedicated content-addressed namespace, bounded chunks and checksum-verified manifests. The database records an upload intent before network writes; a business transaction publishes the artifact reference and removes the intent together. Local packed artifacts remain the default for applications that own local durable storage. Selection is a deployment contract, not an online fallback or an implicit format migration.

An uncertain database commit retains its preparation intent. Recovery may retire intents only for an exact previous writer whose physical stop and ownership fencing the embedding application has established. Collection protects committed references, active preparation, validation and backup/import pins, then waits seven days from the first unreferenced observation. It records deletion before removing exact object hashes and resumes interrupted deletion. Shared chunks remain protected by every retained manifest. Content prefixes must be exclusive to this artifact authority; a bucket-wide sweep is unsupported.

## Alternatives considered

**Copy the Host directory during failover.** This retains a dependency on the failed Host and does not solve simultaneous publication or partial-copy recovery.

**Upload bytes inside the SQL transaction.** External writes cannot be rolled back or safely replayed with database retries.

**Delete every object without a current reference.** This loses bytes uploaded by an active or uncertain preparation and can destroy backup dependencies.

## Consequences

The composition owner supplies an authenticated object adapter and a durable writer identity. Reads fail on missing or corrupt content. Historical local packs require a separate offline migration, and this mechanism does not migrate application assets, secrets, workspaces or snapshots by itself. The [storage contracts](../../../../packages/harness/test/storage/object-artifacts.test.ts) cover fresh-directory recovery and publication/collection boundaries and are registered in the real PostgreSQL test matrix.
