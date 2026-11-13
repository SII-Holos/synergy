# Organization Service

Own identity, authorization, resources, publications/projections, forwarding/handoff and backup/recovery. `synergy-org` reuses CLI. Never run Agents or import Runtime presets. Preserve native Execution/Workspace/Environment owners. See [organization architecture](../../docs/architecture/organization.md).

Use isolated Storage Handles, central migrations and owner-local keys. Commit authorization with admission; Runtime acceptance is separate. Prepare binaries before transactions. Reauthorize downloads/receipts. Keep private member bodies Runtime-owned.

Route actions through `authorization.ts`; resolve stored ownership before roles; deny unknown actions. Pending handoffs block archive; archived projects permit stopping. Authentication and one-time token consumption belong to `auth/`. Never duplicate role matrices in routes or Runtime adapters.

Invitation reads require authorized indexes, excluding secrets/receipts. Keep consume/revoke CAS atomic and migrate indexes centrally. CLI invites require durable private output before HTTPS; never retry unknown issuance; verify `test/cli-invite.test.ts`. Self leave uses the account removal/last-owner guard; verify invite/auth suites.

Page authorized creator/shared Session indexes before records. Capacity exposes counts only. Creation atomically reserves directory metadata with admission; metadata cannot grant execution. Verify `test/session-directory.test.ts` for rollback, revocation and mixed-owner pagination.

Logins bind actual deployments; grants bind logins/callbacks/deployments. Consume codes atomically; refresh replay revokes before error. API tokens bind one project, operations, expiry and current authority. Routes supply trusted purposes; receipts never redisclose secrets. Preserve signed token attribution and current stream authorization. Verify auth-login-incarnation/client-auth/api-tokens suites and generated contracts.

Register config/CLI/history/Home and reader fences. Recover upgrades through original native witnesses; recovery/preparation skips migrations/auth/transports. Preflight history/H1/target before reconciliation. Reserve before fencing; cold completion grants no authority. Reconstruct recovery-held with existing keys. Release requires native completion/writer proofs. Unknown readers/history block. Backup authenticates; restore holds; recover publishes explicitly. Verify service-{home,environment-reader,recovery}, backup/{authority,writers,writer-reconciliation,current-authority,source-retirement,pending-retirement}, cli-{home-upgrade,backup,recovery,recovery-retry,recovery-artifact,recovery-knowledge} and history/configuration/CLI/signing.

Machine sockets enforce registration/account fences at commit. Permits bind Directory ownership. Relays recheck fresh destination signatures/consent/participants; retain no content. Proofs acknowledge original facts, excluding current Views. Native recovery grants no Session read. Hosted/member fences differ; heartbeats indicate availability. Notifications recheck bindings/recipient ACLs. Verify connection/hosted/notifications/`handoff{,-dispatch,-openapi}`/object suites.

Commands derive actors from validated credentials and capture live connections inside admission. Preserve metadata attempts, unresolved receipts and skip proofs across reconnect without replay. Bounded exchanges distinguish dropped, enqueued and unknown sends; observe cancellation independently and recheck binding/access after replies. Verify command-admission and command-forwarding suites plus Presets integration.

Separate resource secrets. Load infrastructure via `./infrastructure`, excluding personal profiles. Keep terminal release and nonterminal closure receipts distinct. Continue preserves original input/root/actor with fresh provenance. Index retained grants atomically; canonical grants/counts remain authoritative. Gateways commit before dispatch and retain drainage capacity/budgets. Verify resource/grant/retention/release/handoff/index/migration suites.

Sharing owns creator CAS, generations and visibility; Runtimes alone commit projections. Opt-in shares portable DTOs/references; private bodies remain Runtime-owned. Task pages seek canonical event versions at fixed watermarks and catch up later writes. Authorize projection/blob reads; never expose paths, credentials or permanent asset URLs. Host retention preserves receipts, generation fences and native pins. Verify retention/sharing/transcript/shared-tasks/shared-history* suites; regenerate SDK after API changes.

Creator-only history and collaborative pending reads use distinct signed transient queries, exact bindings and post-response authorization; never persist bodies. Replies use command admission and current roles; archived projects allow existing confirmations. Verify session-read, interactions and decision-forwarding suites.

Verify publication chunks and authorized receipts. Knowledge pages commit one authorized CAS; preserve member/project/hosted collection owners. Machine reads require exact versions/grants. Blob receipts page and verify before completion; browser uploads require creators. Artifacts retain project access independently of source. Author abandonment terminates only unsealed uploads; collection rechecks terminal/deployment in its transaction, retaining receipts/pins. Reuse ConfigMarkdown/SkillManifest/Storage binaries. Verify publication/publication-retention/knowledge/shared-blob/{artifacts,artifact-history} suites.

Cloud locators own attribution. File CAS/receipts retain root/namespace commit guards and drain before release. Verify cloud and Runtime workspace-files suites.

Drain accepted completions and freeze rosters; incomplete segments block completion. Installations bind native/Snapshot; guard adoption commits. Preflight completed history before retirement. Verify service-maintenance/cohort/service-native*/service-snapshot-install and backup/writer-reconciliation.
