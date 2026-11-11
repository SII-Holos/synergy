# Decision Record: Scope personal API tokens to current project authority

Status: implemented

## Problem

External applications need to create, inspect and control Sessions through the same online admission contract as human clients. Reusing a browser login or first-party client credential would grant unrelated account and organization management operations. An original token persisted in an issuance receipt would also disclose the secret again after a retry.

## Decision

Each personal API token binds one explicit project, a finite operation set, an expiry, the issuing account's authentication revision and the deployment incarnation. The distinct `sy_api_` credential format cannot be exchanged for a browser login or client grant. Applications may create multiple independently scoped tokens; their permissions are never combined within a request and there is no lifetime token-count quota.

Only trusted route code selects the operation context. Unlisted routes reject API credentials. The central authorization owner resolves the actual Session, artifact or resource project and intersects the token with current account state, project membership and the existing role policy. Token scope never grants execution, resource use, private Session visibility or administrator access by itself. Resource configuration, grants, runtime enrollment, sharing and account management are absent from the token operation catalog. The separate `sessions.configure` operation selects an existing idle Session's resources through the canonical current resource-use checks; `resources.read` exposes only authorized project descriptors.

Issuance stores a random token's digest and an independent metadata identity. The stable issuance request ID and complete input digest commit with the record and owner/hash indexes. Only the first successful invocation returns the original secret; repeated or uncertain issuance resolves to metadata with `secretUnavailable`. A lost secret requires explicit revocation and a new issuance request. Neither retry receipts nor token listings retain the original secret. Revocation is personal and revision checked, including an identical retry after acknowledgement loss.

API command actors retain the account principal with `clientKind=api` and the issuing `tokenID`. That optional field enters the signed permit and canonical native attribution; existing actors omit it and preserve their proof encoding. The permit deadline is bounded by the authenticated credential expiry. Token revocation prevents future admission, queries and stream chunks, while already accepted effects retain the existing authorization/reception distinction and are not silently undone or replayed.

## Alternatives considered

**Reuse first-party access tokens.** Their grant authority and browser recovery lifecycle are broader than an external application's project operations.

**Persist the raw secret for idempotent issuance.** A read of an old receipt would become a second secret-disclosure path.

**Authorize only the caller-supplied project.** That would allow guessed Session or artifact identities from another project to cross the intended boundary.

## Consequences

Applications retain Session, artifact and request identities and reconcile uncertain commands explicitly. Cancellation acceptance remains distinct from physical process exit. Secret loss is recoverable through metadata and revocation without retaining a reusable plaintext credential. Backup restoration invalidates these tokens through its new deployment identity.

## Verification

`packages/organization/test/api-tokens.test.ts` uses real isolated SQLite storage, HTTP and machine WebSockets. It verifies one-time issuance, committed SQL acknowledgement loss, restart, current membership, operation/project fencing, token expiry, authentication revision and deployment replacement, signed token attribution and tamper rejection, exact command retries, offline refusal, resource descriptor redaction and retained artifact Range bytes. Revocation interrupts an active artifact stream before its remaining content is emitted. `packages/organization-runtime/test/api-token.test.ts` additionally uses verified HTTPS/WSS and the real native Session/Inbox/Run owners to create work, reconcile a lost HTTP acknowledgement, retain one input with token attribution, cancel its queued Run and refuse later offline/revoked requests. Adjacent authentication, client-grant and command-admission suites preserve their existing contracts.

## Related

- [Organization architecture](../../../architecture/organization.md)
- [Agent storage](../../../architecture/agent-storage.md)
- [Persistent command intake](2026-11-09-persist-organization-command-intake.md)
