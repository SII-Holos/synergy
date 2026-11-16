# Browser logins survived deployment incarnation

## Executive summary

Browser login records omitted deployment identity. A cookie issued under H0 could authorize a fresh H1 client grant after the canonical deployment changed, even though the old refresh and access tokens were correctly rejected. Human login records now require their original organization and incarnation, and request handlers reject unbound or mismatched records.

## Summary

The client authorization owner bound grants to issuer, organization and deployment incarnation, but its original login reader checked only expiry, revocation and account authentication revision. A cookie could therefore become the source of new client authority after a deployment cutover. Unchanged account records did not establish that a login belonged to that new deployment.

## Timeline

1. Review compared the current Login schema, cookie reader, client grant checks, authority history and startup migrations. Login version one had no incarnation, and login records were not private-policy journal projections.
2. An initial fixture tried to open another SQLite writer against the live service and was correctly refused by native ownership. That fixture failure was excluded from behavior evidence.
3. The test then changed the actual deployment through the service's original primary write transaction. The old cookie authorized an H1 client code with HTTP 200 instead of 401; a foreign organization cutover also left cookie reads accepted. Existing refresh and access checks already rejected both the old authority and attempts to relabel an old refresh.
4. The login writer and reader adopted mandatory version-two deployment identity. The new startup migration preserved valid H0 credentials, while missing fields remained rejected during authentication.
5. Real migration and retirement tests covered 131 legacy records, restart, an inconsistent signing/deployment cutover, pre-switch transaction requirements, rollback and caller input mutation.
6. Review found a nested-transaction failure gap in the new retirement helper. An actual second-page deletion failed after its staged removal; the caller caught the error, wrote the new deployment and committed. The helper now retains completion and the original failure in an outer commit guard. Real fixtures verify rollback after the caught 129th deletion failure and refusal while an unawaited deletion is still held.

## Root cause

Account authentication revision was treated as sufficient login provenance. It identifies account policy changes, while deployment incarnation identifies the service authority under which the credential was issued. Rejecting an old derived grant does not close a surviving cookie's ability to authorize another one. The retirement helper also originally relied on its caller propagating failures. Nested writes share the outer transaction, so catching a late failure could commit a partial retirement together with the fresh deployment unless completion constrains the actual COMMIT.

## Guardrails

- [x] Machine check: `packages/organization/test/auth-login-incarnation.test.ts` tests old-cookie-to-new-grant rejection after a real deployment write and preserves the existing refresh/access rejection controls.
- [x] Machine check: the same test uses the real central startup runner to preserve valid original-deployment credentials across multi-page legacy upgrade and restart, and verifies that handlers do not fill missing identity.
- [x] Machine check: the same test verifies actual-transaction legacy retirement, fixed pre-switch identity, rollback and refusal after deployment publication.
- [x] Machine check: caught second-page deletion failure preserves the original error at outer COMMIT and rolls back every deletion and deployment change; an unfinished retirement also blocks COMMIT.
- [x] Owning procedure: the persistence Skill requires migration under verified original authority and legacy retirement before fresh incarnation publication.

## Lessons

Credential provenance must survive restoration independently of account policy revision. Preserve valid same-deployment credentials through owning migration, and never use a new current deployment as a request-time default for an old credential. See [deployment-bound human logins](../decisions/implemented/bug-fix/2026-11-12-bind-human-logins-to-deployment-incarnation.md).
