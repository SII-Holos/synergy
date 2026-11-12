# Organization Service

Own identity, authorization, resources, publications/projections, forwarding and handoff. `synergy-org` reuses CLI. Never run Agents or import Runtime presets. Preserve native Execution/Workspace/Environment owners. See [organization architecture](../../docs/architecture/organization.md).

Use isolated Storage Handles, central migrations and owner-local keys. Commit authorization with admission; Runtime acceptance is separate. Prepare binaries before transactions. Reauthorize downloads/receipts. Keep private member bodies Runtime-owned.

Route actions through `authorization.ts`, resolving stored ownership before roles; deny unknown actions. Archived projects allow stopping, not new execution. Authentication and one-time token consumption belong to `auth/`. Do not duplicate role matrices in routes or Runtime adapters.

Invitation reads require authorized indexes, excluding secrets/receipts. Keep consume/revoke CAS atomic and migrate indexes centrally. CLI invites require durable private output before HTTPS; never retry unknown issuance; verify `test/cli-invite.test.ts`. Self leave uses the account removal/last-owner guard; verify invite/auth suites.

Page authorized creator/shared Session indexes before records. Capacity exposes counts only. Creation atomically reserves directory metadata with admission; metadata cannot grant execution. Verify `test/session-directory.test.ts` for rollback, revocation and mixed-owner pagination.

Logins bind actual deployments; grants bind logins/callbacks/deployments. Consume codes atomically; refresh replay revokes before error. API tokens bind one project, operations, expiry and current authority. Routes supply trusted purposes; receipts never redisclose secrets. Preserve signed token attribution and current stream authorization. Verify auth-login-incarnation/client-auth/api-tokens suites and generated contracts.

Register config/CLI/history/Home. Preserve identities/history. Frozen maintenance guards upgrades. Recovery skips migrations/auth/transports. Reserve retirement before format 4 fencing; cold completion grants no authority. Reconstruct policy under recovery-held; reopen existing keys. Publication requires native completion/writer proofs before hold release. Preserve format 3 fences. Unknown readers/history block. Verify service-{home,recovery}, backup/{authority,writers,writer-reconciliation,current-authority,source-retirement}, history/configuration/CLI/signing.

Machine sockets preserve registration/account checks, fences and commit guards. Handoff permits bind Directory source ownership. Object relays verify fresh destination signatures, consent and participants before/after forwarding; retain no content. Heartbeats indicate availability. Hosted/member fences differ. Notifications recheck binding/recipient ACLs. Verify connection, hosted, notifications and handoff-dispatch/object suites.

Commands derive actors from validated credentials and capture live connections inside admission. Preserve metadata attempts, unresolved receipts and skip proofs across reconnect without replay. Bounded exchanges distinguish dropped, enqueued and unknown sends; observe cancellation independently and recheck binding/access after replies. Verify command-admission and command-forwarding suites plus Presets integration.

Separate resource secrets. Load infrastructure via `./infrastructure`, excluding personal profiles. Keep terminal release and nonterminal closure receipts distinct. Continue preserves original input/root/actor with fresh provenance. Index retained grants atomically; canonical grants/counts remain authoritative. Gateways commit before dispatch and retain drainage capacity/budgets. Verify resource/grant/retention/release/handoff/index/migration suites.

Sharing owns creator CAS, generation fences, visibility and checkpoint/idempotency commits. Opt-in shares portable DTOs/references; private bodies remain Runtime-owned. Task pages seek canonical event versions at fixed watermarks and catch up later writes. Authorize every projection/blob read; never expose paths, credentials or permanent asset URLs. Host retention preserves receipts, generation fences and native pins. Verify retention/sharing/transcript/shared-tasks suites; regenerate SDK after API changes.

Creator-only history and collaborative pending reads use distinct signed transient queries, exact bindings and post-response authorization; never persist bodies. Replies use command admission and current roles; archived projects allow existing confirmations. Verify session-read, interactions and decision-forwarding suites.

Publications verify release chunks; reconcile read-authorized receipts. Knowledge stages pages before one authorized CAS pointer; member/project and hosted collections retain their owners. Machine reads require exact versions and grants. Shared blobs page receipts, verify before completion and restrict browser uploads to creators. Artifact lifetime follows project access independently of source. Reuse ConfigMarkdown/SkillManifest and Storage binaries. Verify publication, knowledge, shared-blob and artifact suites.

Cloud locators own attribution. File CAS/receipts retain root/namespace commit guards and drain before release. Verify cloud and Runtime workspace-files suites.

Maintenance retains accepted completions and freezes rosters; incomplete segments block completion. Installation requests bind native/Snapshot; both owners guard adoption commits. Verify service-maintenance/cohort/service-native*/service-snapshot-install with isolated Homes.
