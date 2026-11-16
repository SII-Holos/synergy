# Decision Record: Restore acknowledged Member data through Service history owners

Status: implemented

## Problem

The organization backup includes uploaded Service data from Member Runtimes. Acknowledged shared text and attachments therefore require recovery independently of an offline Member's private Home. Treating every retained Runtime-related record as an active native writer blocks that data; treating whole record namespaces as safe would restore unverified execution authority.

## Decision

Each domain validates its own historical records. Shared projection and task readers check canonical event versions, indexes, preparation relationships and derived pointers. Blob history verifies original complete manifests and actual native bytes; every available attachment/blob or nested content reference must resolve to its exact original manifest. A completed cursor alone does not establish complete history.

Member registration, device, ticket, connection and resource-selection readers verify their original relationships while preserving historical deployment identities. Member command history has a separate acknowledged-metadata reader for genuine create and pause receipts, original signatures, attempts, request indexes and sequence watermarks. Hosted terminal history retains its original native acceptance requirements. Invitation history verifies original catalogs and consumption relationships without requiring unchanged current roles.

The writer inventory records only exact keys accepted by these owners. Complete Source and Target comparison still validates their values; unknown, incomplete or unsupported state remains blocked. The actual Target installation supplies the fresh publication incarnation. Preserved Member metadata cannot adopt that identity, including through a previously known-key shortcut. Current H1 account/project policy independently controls restored reads and future commands.

Administrative recovery awaits work owned by an asynchronously disposed Source before returning from its callback. This keeps its returned rejection under the caller while native cleanup runs, without changing the authorization guard or suppressing errors.

## Alternatives considered

**Require the offline Member's private Home.** The verified uploaded Service projection is already part of the archive. Recovering it must not read or modify unuploaded private data.

**Allow entire metadata namespaces.** A known prefix does not prove signatures, dependencies, native byte integrity or current publication ownership.

**Relabel historical Members with the new deployment.** This would turn preserved evidence into fresh execution authority without enrollment or native writer reconciliation.

## Consequences

Verified uploaded text and binary data can recover with current access policy while the Member remains offline. Original Member keys, private files and identities remain unchanged. Recovery does not activate its old machine, replay work or enable Continue. Actual HTTPS/WSS tests cover acknowledged upload and binary recovery, current revocation and old-login rejection, command history, corrupt derived/native data, missing referenced manifests, orphan native artifacts and collision with the actual fresh Target. Unsupported business deltas and native writer cohorts retain their explicit blockers.
