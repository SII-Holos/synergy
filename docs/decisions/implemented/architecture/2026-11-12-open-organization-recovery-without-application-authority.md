# Decision Record: Open organization recovery without application authority

Status: implemented

## Problem

An ordinary organization-service startup initializes canonical deployment state, loads its active signing identity and constructs authentication and machine transports. Those effects are inappropriate while an independent target contains only part of a recovery. Importing old SQL cannot authorize its old signer or make a missing initialization marker look like a fresh deployment.

## Decision

The existing service lifecycle exposes `openOrganizationRecovery({ home, database? })` as a trusted native entrypoint. It shares dedicated Home validation, actual process-lock acquisition, primary Store ownership and drainage/cleanup with the service and Home-upgrade modes. It exposes only trusted `run`, `close` and disposal; no HTTP, bootstrap or WebSocket adapter is created, and its Runtime context is not marked ready.

Recovery registers the single Harness `HomeRestoration` guard before composition seals. It retains domain schema and authority-history definitions for owning validation, but does not execute startup migrations, assert an initialized deployment, load an active signer, construct authentication or register cloud execution adapters. Existing signing material remains inert and can be inspected through the owning restricted context without being converted into active authority.

Ordinary service and Home-upgrade startup invoke the unfinished-installation reader assertion before application migrations and signing load. An incomplete intent therefore cannot be repaired by normal initialization. A cold recovery handle can rejoin the exact original native installation intent. Closing it rejects new trusted callbacks and drains its already accepted callback before disposing the Store and native writer.

## Alternatives considered

**Use ordinary service startup and hide its routes.** Deployment migrations and signer/authentication construction happen before route exposure. Hiding endpoints would not prevent those effects.

**Build a separate recovery storage opener.** Duplicating Home validation, process locking, SQLite/PostgreSQL ownership and cleanup would create different native lifetimes for the same namespace.

**Let startup manufacture missing deployment records.** Missing records can mean a half-restored target. New initialized records would conceal incomplete source material and split its identity.

## Consequences

There is now an inert native context for the later recovery coordinator to prepare and validate one target. It is not a deployment-restoration API and cannot certify complete segments, current ACLs, old-writer retirement or permission to Continue. Actual Hosted files, Snapshot adoption, resource restoration, fresh signing/auth invalidation and guarded publication remain owning operations. The existing service Home reader contract is unchanged in this unit: released-reader fencing for the final installed recovery must be supplied by the native Home installation owner rather than inferred from this new reader's intent check.

The source checkpoint also contains its native maintenance records. The eventual maintenance owner must adopt those as retained source evidence under a new target recovery boundary; deleting or marking the old operation released is not a valid recovery coordinator shortcut.

## Verification

`packages/organization/test/service-recovery.test.ts` opens real independent Homes and primary SQLite Stores. It observes an empty namespace without generated deployment/signing state or public authority, creates and cold-reopens the original installation intent, and verifies that ordinary startup refuses it without initializing records. Invalid old signing material remains unchanged and inert across restricted restarts. A held accepted callback proves shutdown rejection and drainage. Fixtures do not open listeners or start Agents. The adjacent legacy signing-ledger fixture now enters the actual restricted frozen Home upgrade before ordinary startup, retaining its original deployment and signing-migration retry assertions instead of bypassing the current reader fence.
