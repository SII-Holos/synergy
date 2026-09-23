# Decision Record: Require verified Workspace directory identities

Status: implemented

## Problem

A legacy directory can be absent when its Workspace reference is migrated. The catalog retains the historical path without a physical identity. If access checks only compare identities when the old value exists, a new directory at the same path becomes accessible through the historical reference without a rebinding decision.

## Decision

`WorkspaceBinding.validate` requires a stored physical directory identity before admitting local execution or files. A missing identity reports `WorkspaceUnavailable` and requires explicit rebinding. Historical metadata and Session references remain readable. Re-registering a location preserves the existing record and does not silently add authority. Rebinding verifies the selected directory, captures its identity and advances the binding generation.

## Alternatives considered

**Adopt the first directory found later.** Availability does not prove continuity with the historical files. This would authorize unrelated bytes under an old Session and generation.

**Fill the physical identity during registration.** Registration deduplicates locations; changing a shared binding there would bypass the explicit rebinding lifecycle and invalidate neither outstanding references nor old file tabs.

**Delete unresolved historical references.** The original location and identity remain useful for history and user-directed recovery. Refusing native access preserves that information without inventing file ownership.

## Consequences

Users explicitly rebind locations that could not be verified during migration. Existing verified bindings and no-Workspace Sessions retain their behavior. No persisted schema rewrite or opportunistic backfill is needed: admission checks protect already persisted unresolved records. The [incident record](../../../postmortem/0028-unverified-workspace-directory-access.md) and the native route regression cover absent paths, repeated registration, explicit rebind, stale generations and replacement after verification.
