# Organization Runtime Adapter

Own bindings, bridge, command intake, synchronization and resource adapters. Service owns identity/authorization. Verify epochs and attribution without role tables. Reuse Harness execution owners and Inbox; never duplicate scheduling. See [organization architecture](../../docs/architecture/organization.md).

Compose through Agent Runtime with explicit exclusive sources and fixed gateway SDKs in both worker roles. Personal configuration, credentials, ancestor/global Skills and plugins cannot leak into organization compositions. Hosted execution excludes Desktop and Memory. Authorization derives from accepted Inbox/root evidence and current grants, never enrollment alone. Verify Runtime/execution-source suites.

Read project configuration through Harness ProjectConfig with an explicit field allowlist documented in architecture. Missing values never invoke the personal loader. Session ownership belongs to the registered schema: validate immutable bindings and Cortex inheritance before transactional publication; ordinary import cannot grant ownership. Verify session-binding storage/restart tests.

Provision member Homes by organization/account/device and hosted Homes by organization/host before startup. Preserve keys across retries; damaged or mismatched credentials need explicit recovery. Tickets remain in memory and snapshots never replace live authorization. Keep home/registration modules usable by Node hosts without Agent lifecycle or Bun networking. Reuse HomeOwnershipFile, bounded reads and positive test-home guards. Verify real Node Home and HTTPS enrollment tests; never disable TLS validation.

Member HTTP uses Server with explicit loopback port and private bearer. CLI consumes bounded private stdin and reuses lifecycle. Components contribute discovery only; selected Runtime entrypoints own composition. Spawn through environment preparation, disable implicit loader inputs and preserve only the verified member installation pin. Test source and installed launches separately.

Local project defaults stay in Scope and WorkspaceCatalog. Bind with CAS and stable receipts; return safe labels only. Validate native defaults before signed creation's transaction and recheck revisions inside it. Native-only composition excludes personal profile resolution. Verify `test/local-project.test.ts`.

Bridges declare implemented capabilities, commit matching epochs before ACK and never lower them for stale snapshots. Preserve errors through socket close, cancel checkpoint waits and drain admitted callbacks before disposal. Saturated command windows cannot block heartbeat/reconciliation. Resident bridges own clients/release observers; discovery stays disconnected. Verify real WSS fencing, liveness, capacity, reconnect and storage-close drainage.

Verify deployment signing identity before checkpoints; signatures never bypass admission. Separate logical effects from attempts/skips and commit effects with release entries. Continue validates pause/version; Cancel retains its lock through drainage. Recheck bindings independently of activity. Describe resources before root creation; bind canonical root/Run evidence. Decisions reuse native owners, retain Scope for deferred settlement and reconcile uncertain commits without new admission. Verify `test/decision-*.test.ts` and rollback/restart suites.

Knowledge sources verify paged releases before atomic per-Session manifest selection. Headers exclude full release collections; exact hashes reuse immutable seals. Machine reads refresh accepted proofs and check exact versions. Reuse canonical Skill parsing/resolution; local sources include only member Home and selected project roots. Hosted Sessions exclude filesystem Skills and global latest directories. Reauthorize content/reference reads and preserve prior manifests and edited files on failure. Verify knowledge, upgrade and signed execution suites plus Local Runtime Skill snapshot/catalog suites.

Shared transcript export uses portable DTOs, ordered durable outboxes, generation/hash checkpoints and authorized chunk references. Private bodies remain local. Verify exporter/transcript migrations, restart and lost-ACK tests.

Private reads share a dispatcher with canonical Scope/lineage and captured binding fences. Creator-only remote permits bind queries and current machine authority. Bound headers/ranges, preparation and provenance; exclude native paths/arbitrary metadata. Verify `test/session-read*.test.ts`; regenerate both SDKs for contract changes.

Desktop Browser requires private managed launch data, explicit listener authentication and lazy page creation. Reject inherited native credentials and non-Desktop selection. Hosted/member machines share bridge/intake/worker composition; hosted identities have no human account. Verify desktop, hosted-home and hosted-runtime suites.

Isolate Homes/tests under test/; run focused tests/typecheck. Root owns package/dependency checks; preserve active Runtimes.
