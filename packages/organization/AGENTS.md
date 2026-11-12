# Organization Service

Own identity, authorization, resources, publication/projection storage, forwarding and handoff. Never run Agent loops or import Runtime presets. Preserve native Execution/Workspace/Environment owners. See [organization architecture](../../docs/architecture/organization.md).

Use isolated Storage Handles, central migrations and owner-local keys. Commit authorization with admission; Runtime acceptance is separate. Prepare binaries before transactions. Reauthorize downloads/receipts. Keep private member bodies Runtime-owned.

Route actions through `authorization.ts`, resolving stored ownership before roles; deny unknown actions. Archived projects allow stopping, not new execution. Authentication and one-time token consumption belong to `auth/`. Do not duplicate role matrices in routes or Runtime adapters.

Invitation management reads authorized metadata indexes, never token digests or consumption receipts. Keep consume/revoke CAS atomic and upgrade indexes through the central migration runner. Self leave uses the account removal owner and last-owner guard; verify `test/invites.test.ts` with `test/auth.test.ts`.

Page authorized creator/shared Session indexes before records. Capacity exposes counts only. Creation atomically reserves directory metadata with admission; metadata cannot grant execution. Verify `test/session-directory.test.ts` for rollback, revocation and mixed-owner pagination.

Client grants bind login, callback and deployment. Consume codes atomically; refresh replay revokes before error. API tokens bind one project, operations, expiry and current authority. Routes supply trusted purposes; receipts never redisclose secrets. Preserve signed token attribution and current stream authorization. Verify client-auth/api-tokens suites and generated contracts.

Register config/CLI/history/Home owners before startup. Dedicated absolute Homes use organization config. Preserve v2 readers, signing identities and unbranched history. Legacy upgrades require frozen native maintenance. Restricted recovery retains imported holds, skipping migrations/auth/transports. Permanent format 3 installation fences persist. Unknown history/readers block; journals never authorize. Verify service-{home,recovery}, authority-history/configuration/CLI/signing/backup/authority suites.

Machine sockets preserve registration/account checks, fences and commit guards. Handoff permits bind Directory source ownership. Object relays verify fresh destination signatures, consent and participants before/after forwarding; retain no content. Heartbeat expiry signals availability. Hosted authority is human-independent; member account fences differ. Verify connection, hosted and handoff-dispatch/object suites.

Commands derive actors from validated credentials and capture live connections inside admission. Preserve metadata attempts, unresolved receipts and skip proofs across reconnect without replay. Bounded exchanges distinguish dropped, enqueued and unknown sends; observe cancellation independently and recheck binding/access after replies. Verify command-admission and command-forwarding suites plus Presets integration.

Separate resource secrets. Bind explicit infrastructure references to canonical cloud objects. Keep terminal release and nonterminal closure receipts distinct. Continue preserves original input/root/actor with fresh provenance. Index retained grants atomically; canonical grants/counts remain authoritative. Gateways commit before dispatch and retain drainage capacity/budgets. Verify resource/grant/retention/release/handoff/index/migration suites.

Sharing owns creator-only CAS, generation fencing, visibility indexes and checkpoint/idempotency commits. Explicit opt-in shares portable transcript DTOs and content references; private bodies remain Runtime-owned. Task pages seek canonical event versions at a fixed watermark and catch up later writes. Authorize every projection/blob read; never expose local paths, credentials or permanent asset URLs. Verify sharing/transcript/shared-tasks suites and regenerate SDK after protocol/routes change.

Creator-only history and collaborative pending reads use distinct signed transient queries, exact bindings and post-response authorization; never persist bodies. Replies use command admission and current roles; archived projects allow existing confirmations. Verify session-read, interactions and decision-forwarding suites.

Publications verify immutable chunks before release. Knowledge stages pages before one authorized CAS pointer; member/project and hosted collections retain their owners. Machine reads require exact versions and grants. Shared blobs page receipts, verify before completion and restrict browser uploads to creators. Artifact lifetime follows project access independently of its source. Reuse ConfigMarkdown/SkillManifest and Storage binaries. Verify publication, knowledge, shared-blob and artifact suites.

Cloud locators own attribution only. Keep file CAS and operation receipts atomic and compose explicit infrastructure without personal configuration. Verify `test/cloud.test.ts`.

Track accepted service operations and exact completions through maintenance. Freeze the roster before capture; incomplete native/resource segments block completion. Verify service-maintenance/cohort/service-native* with isolated Homes.
