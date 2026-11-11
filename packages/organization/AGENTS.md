# Organization Service

Own identity, authorization, resources, publication/projection storage, forwarding and handoff coordination. Never run Agent loops or import Runtime presets. Execution, Workspace heads and Environment lifecycle remain with canonical owners. See [organization architecture](../../docs/architecture/organization.md).

Use an isolated Storage Handle, central migrations and owner-local keys. Keep authorization and admission in the same organization transaction; Runtime acceptance is separate. Prepare binary objects before retryable metadata transactions. Downloads and receipt reads require current authorization. Never copy private member Session bodies into forwarding records.

Route actions through `authorization.ts`, resolving stored ownership before roles; deny unknown actions. Archived projects allow stopping, not new execution. Authentication and one-time token consumption belong to `auth/`. Do not duplicate role matrices in routes or Runtime adapters.

Invitation management reads authorized metadata indexes, never token digests or consumption receipts. Keep consume/revoke CAS atomic and upgrade indexes through the central migration runner. Self leave uses the account removal owner and last-owner guard; verify `test/invites.test.ts` with `test/auth.test.ts`.

Page authorized creator/shared Session indexes before records. Capacity exposes counts only. Creation atomically reserves directory metadata with admission; metadata cannot grant execution. Verify `test/session-directory.test.ts` for rollback, revocation and mixed-owner pagination.

Client grants bind the first-party login, exact callback and deployment. Consume authorization codes atomically with token creation. Refresh replay commits revocation before error; expired proofs may revoke their own login only. Cross-origin clients use access tokens, not cookies. Preserve generated organization contracts; verify `test/client-auth.test.ts` and Web authorization headers/HTML fallback.

Configuration/CLI components register before startup. Require an absolute Home before writes and read only the organization domain. Keep initialization secrets out of argv/stdout. Signing identity is migration-owned: damaged completed credentials require recovery, never replacement. Verify configuration, CLI, migration and signing suites.

Machine sockets run callbacks in the service context, verify registration/account state, fence superseded connections and carry liveness guards through commit. Heartbeat expiry is availability only. Hosted machines have administrator-owned authority independent of a human; member account fences remain distinct. Verify Runtime connection and hosted suites.

Commands derive actors from validated credentials and capture live connections inside admission. Preserve metadata attempts, unresolved receipts and skip proofs across reconnect without replay. Bounded exchanges distinguish dropped, enqueued and unknown sends; observe cancellation independently and recheck binding/access after replies. Verify command-admission and command-forwarding suites plus Presets integration.

Resource secrets remain separate. Atomically update grants, bind from native evidence, inspect retention without acquisition, release drained generations and fence old capabilities. Gateways reauthorize, commit before transmission and retain capacity through drainage; preserve native budgets. Verify resource, grant, retention, release, gateway and migration suites.

Sharing owns creator-only CAS, generation fencing, visibility indexes and checkpoint/idempotency commits. Explicit opt-in shares portable transcript DTOs and content references; private bodies remain Runtime-owned. Authorize every projection/blob read; never expose local paths, credentials or permanent asset URLs. Verify sharing/transcript suites and regenerate SDK after protocol/routes change.

Creator-only reads use signed transient queries, exact bindings and post-response authorization; never persist their bodies. Shared replies use signed command admission and current collaboration roles; archived projects allow existing confirmations. Private Read cannot authorize collaborators. Verify `test/{session-read,decision-forwarding}.test.ts`.

Publications verify immutable chunks before release. Knowledge stages pages before one authorized CAS pointer; member/project and hosted collections retain their owners. Machine reads require exact versions and grants. Shared blobs page receipts, verify before completion and restrict browser uploads to creators. Artifact lifetime follows project access independently of its source. Reuse ConfigMarkdown/SkillManifest and Storage binaries. Verify publication, knowledge, shared-blob and artifact suites.

Cloud locators own attribution only. Keep file CAS and operation receipts atomic and compose explicit infrastructure without personal configuration. Verify `test/cloud.test.ts`.

Tests live under `test/` with isolated storage, Homes and ports. Run package typecheck and focused suites; preserve active Runtimes.
