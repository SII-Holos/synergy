# Decision Record: Bind human logins to deployment incarnation

Status: implemented

## Problem

Opaque browser login records retained an account and authentication revision but no deployment identity. Client grants already checked deployment incarnation. After changing the actual deployment record, an old browser cookie could therefore authorize a new client grant under the new incarnation, bypassing the old grant's rejection.

## Decision

The current private Login record is version two and requires organization and deployment incarnation. Login publication reads the canonical deployment inside its account-validation transaction and rejects a foreign account organization. Authentication accepts only that strict current record, matches its token key, deployment and account organization, and retains existing expiry, account-state and authentication-revision checks. It never supplies missing deployment fields during a request. Client refresh and access retain their existing deployment checks.

The owning startup migration runs after authority-history initialization. It validates the original canonical deployment and signing authority, then upgrades legacy rows in bounded pages within its original write transaction. Token digests, CSRF digests, expiry, revocation and account revisions remain unchanged. Normal upgrades preserve valid original-deployment cookies and refresh credentials; the migration does not renew them or change accounts. Unsupported or inconsistent records block migration.

Fresh deployment publication must call `OrganizationLoginSessions.retireLegacyLogins` before changing incarnation in the same write transaction. The helper snapshots the expected original deployment, binds the actual Runtime, Store and transaction, validates current pre-switch identity and pages deletion of legacy version-one login records. A nested commit guard requires successful completion at the original outer COMMIT and preserves any deletion failure even if the caller catches it. An unfinished helper cannot let deployment publication commit. It returns a count, not authorization evidence. Current version-two rows retain their original identity and fail authentication after the deployment changes. A post-switch call with the old identity is rejected. This helper adds no authority ledger or authentication fallback; the recovery publication owner remains responsible for consuming it before fresh identity publication.

## Alternatives considered

**Fill missing incarnation during authentication.** An old restored cookie would inherit the new deployment and could authorize a new grant. Request handlers cannot determine an unbound legacy credential's origin.

**Invalidate every login during ordinary startup upgrade.** Valid credentials under an unchanged original deployment can be preserved by the owning migration. A deployment cutover is a separate publication operation.

**Rely only on client-grant incarnation.** A browser cookie can authorize another grant. The original human login must carry the same identity restriction.

## Consequences

The private persisted record changes without changing HTTP response schemas or generating a new SDK. Synthetic authorization fixtures explicitly provide deployment-bound credentials; a foreign-deployment cookie now fails authentication before object lookup. Tests cover actual deployment writes, the old-cookie-to-new-grant defect, unchanged refresh rejection, multi-page legacy upgrade, restart, missing-field refusal and transactional legacy retirement with rollback and fixed inputs. Real staged deletion failures caught by the outer callback and an unawaited held deletion both prevent its deployment write from committing. Fresh signer publication, complete deployment recovery and readiness remain separate owners; this change does not claim their integration.
