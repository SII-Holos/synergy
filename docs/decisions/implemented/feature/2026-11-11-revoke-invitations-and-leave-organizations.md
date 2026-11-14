# Decision Record: Revoke invitations and leave organizations

Status: implemented

## Problem

An administrator can issue an invitation but needs to inspect or revoke it after closing its one-time link. Members also need to end their organization membership independently of signing out of one client. Reusing invitation tokens as public management identifiers would expose credentials in lists, requests and logs; an account exit must preserve attribution and the last owner.

## Decision

Invitation records retain a separate random public identifier and a revision. The identity owner lists bounded metadata pages through organization and issuer indexes; it projects only role, issuer, known creation time, expiry, revision and current state. The token digest and consumption receipt remain private. A central startup migration upgrades retained invitations and builds both indexes in bounded transactions without fabricating historical creation times.

The current issuer or a current organization administrator can revoke an unconsumed invitation using its observed revision. Revocation and consumption serialize in the same storage transaction and advance that revision. A consumed invitation retains its original public account receipt and cannot remove the account through invitation revocation. An invalidated issuer does not make an unconsumed invitation usable again.

Self leave derives the account from current credentials and accepts only its expected revision. It uses the same account mutation owner, last-owner check, authentication revision and post-commit connection removal hook as administrator removal. The retained account becomes removed, preserving project and conversation attribution. Concurrent exits serialize against the authoritative owner set.

The organization Account view exposes invitation history and membership exit to every current account. It confirms revocation with the displayed invitation revision and obtains the current account revision before confirmed exit. Administrator member management displays one-time reset links with their expiry without persisting them; ownership transfer reads the organization's revision separately from either account revision. These views use the shared theme, controls and space navigation independently of personal Runtime availability.

## Alternatives considered

**List invitation links or digests.** These identifiers carry authentication material or couple a public catalog to secret storage. Independent public identifiers permit safe metadata and exact authorization without returning credentials.

**Use sign-out as organization exit.** Sign-out revokes a login while leaving membership and machine authority intact. Membership removal must update the account and revoke its active authority through the existing owner.

**Delete exiting accounts.** Deletion breaks historical attribution and complicates last-owner and login revocation. Retaining removed identities preserves those invariants.

## Consequences

Invitation management adds two small identity indexes and an owning migration. Metadata reads still authorize the current account; a formerly administrative issuer sees only their own invitations. An expired or invalidated invitation remains visible for audit and can be revoked. A last owner must transfer ownership before leaving. HTTP behavior tests cover safe pagination, demotion, CAS, consumed invitations, legacy upgrade, restart and concurrent exits.
