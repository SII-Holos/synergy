# Decision Record: Fence native organization service Home readers

Status: implemented

## Problem

A service process that understands native maintenance can retain a frozen namespace, but an earlier service reader can ignore those operation records when reopening the same version-one Home. A SQL deployment label also cannot identify the physical Home or primary Store supplying a backup namespace. Reader compatibility and namespace identity require their actual owners.

## Decision

The organization service owns a version-two Home marker with the same owner and identity digest as version one and an explicit native service reader contract. Ordinary service startup selects that reader and rejects a retained legacy or unknown contract before opening business endpoints. Fresh ownership is persisted by the existing startup migration. The Home maintenance migration depends on the existing organization authority-history baseline so its probe observes the established deployment and signing identity rather than preceding their startup owners. Startup checks the canonical Home initialization receipt before pending migrations: a completed initialization with a missing marker requires recovery. The existing initializer publishes the durable Home marker and its receipt before signing can run; incomplete fresh initialization can therefore resume without inventing an ownership history.

A separate trusted native upgrade entry uses the same service startup, SQL namespace, history registration and cleanup implementation. Its fixed restricted mode exposes the native maintenance runner and explicit upgrade only; it creates no authentication service, Runtime socket, gateway, HTTP application or Agent loop. Callers cannot select this mode with an ordinary service option. The upgrade requires the current Runtime's opaque frozen maintenance lease and installed primary writer evidence. It retains the native operation lock across filesystem work and central receipt publication, forwards the original cancellation signal to both file locks and preserves the organization, deployment, signing keys and public identities.

The owning migration fences the file before recording its completion. A failed receipt leaves the durable version-two reader refusal in place, and the same live frozen operation can complete the central receipt on retry. Unknown or foreign ownership is preserved and rejected. A completed receipt paired with a downgraded or missing Home marker is an error, not permission to adopt that input. Cold retained maintenance still requires independent writer reconciliation; this upgrade does not manufacture a prior Runtime's lease.

Both service and Hosted backup sources consume the public native namespace identity owner. The service reader verifies its actual Home, canonical deployment and matching signing key pair. The opaque evidence binds the original Runtime, primary Store, concrete artifact configuration, reader fence and installed writer lifetime. The service backup factory no longer accepts copied deployment metadata from an arbitrary Agent Home as its identity certificate.

## Alternatives considered

**Continue serving version-one Homes.** An old reader would remain eligible to reopen a retained maintenance namespace without understanding its native holds.

**Automatically change the ownership file during ordinary startup.** This provides no explicit frozen owner lifetime and makes a routine restart perform the compatibility transition.

**Add an administrator upgrade route or duplicate a minimal server.** A trusted native operation does not need account HTTP authority, and a second startup implementation would diverge in migrations, signing, storage and cleanup.

## Consequences

Existing version-one service Homes require explicit native upgrade before ordinary serving. Restricted upgrade and normal serving share one namespace lifecycle while exposing different fixed capabilities. The format fence proves that the tested previous strict reader rejects reopening; it does not prove that arbitrary old processes, another deployment using the database or remote resource writers have stopped. Complete deployment restore still needs fresh-incarnation, credential, resource, ACL and unique-writer owners.

## Verification

Organization `test/service-home.test.ts` starts a real service to establish deployment and signing state, seeds the released version-one input without its future migration receipt, and runs the previous strict reader in an independent process. The reader succeeds before upgrade and refuses the version-two file afterward. Real primary SQLite and native service maintenance verify frozen, forged, foreign-Home, unknown-contract, retained file-lock cancellation and receipt-failure recovery behavior without replacing signing material.

Two actual fresh-provisioning failures verify this ordering: interruption before owner publication leaves no signing record, while a signing commit with a failed receipt retains its earlier Home marker and reopens without key rotation. A lost established marker leaves a pending signing receipt unchanged instead of repairing SQL before rejecting the Home. The product-path tests verify fresh version-two startup, ordinary legacy refusal, restricted upgrade without HTTP/socket/bootstrap capabilities, explicit frozen migration and successful normal reopening. A real Agent Runtime with copied public deployment metadata is rejected as a service backup source. The cohort suite verifies actual service identity alongside Hosted evidence. These fixtures do not establish PostgreSQL deployment reconciliation or complete recovery acceptance.
