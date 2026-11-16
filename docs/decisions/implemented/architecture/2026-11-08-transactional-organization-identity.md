# Decision Record: Transactional organization identity and project access

Status: implemented

## Problem

Concurrent invitation consumption, ownership changes and project role updates can create duplicate accounts or authorize work after membership has changed. Browser login state must remain revocable across service restarts without exposing reusable credentials in public records or validation errors.

## Decision

Keep organization identity, token digests, login-name indexes, ownership and project memberships in the organization's SQL namespace. Use the existing transaction owner for admission, revision checks and publication of access indexes. Token consumption persists an immutable public receipt keyed by the logical request and a token-keyed payload fingerprint. Password hashing runs outside transactions with explicit Argon2id costs and bounded concurrency; the transaction rechecks the current account revision before granting a login or changing credentials.

Use opaque revocable browser sessions, an exact configured HTTPS Origin and a session-bound CSRF token. Authentication revisions revoke existing login state after password, membership or role changes. Preserve removed account records for attribution. Keep project execution permission separate from organization administration, and model project archive/restore as revisioned lifecycle changes without scheduling execution. The [organization architecture](../../../architecture/organization.md) defines the current contract.

## Alternatives considered

**Authorize each account and project handler independently.** This spreads owner protection and object resolution across endpoints. A single action-based authorization owner resolves the target from stored records, checks its actual organization and denies unknown actions. Authentication stays separate so credential exchange can validate the issuing account without creating a second role authority.

- Stateless signed login tokens would retain revoked authority until expiry or require a separate revocation lookup, so opaque server-owned state is simpler here.
- Checking permissions before entering the transaction would allow competing role changes to invalidate the decision before commit.
- Re-reading an account for an idempotent invitation retry would return a different result after a rename or removal. Persisting the original public result preserves the accepted fact without reissuing credentials.
- A shared permission union across projects would erase intentional differences between collaborator and reader roles.

## Consequences

Authorization requires current storage reads. Indexes and authoritative membership records must be maintained together, and pagination must begin with the authorized collection. Password costs are explicit and independently bounded. Browser login requires an HTTPS public origin and clients must preserve the cookie and CSRF token. Validation responses contain structured errors and request identifiers, never submitted credentials. Session admission, live subscription revocation and handoff control must reuse this authority as those owners are added.
