# Organization Runtime Adapter

Own the Runtime's organization binding, trusted bridge, command receiver, synchronization exporter and remote resource adapters. Identity and project authorization belong to the organization service; this package verifies service identity and execution epochs and preserves actor attribution without maintaining user role tables.

Use Harness execution owners and Inbox; never create another scheduler. Personal configuration, credentials and global Skill sources cannot leak into organization compositions. Hosted execution excludes Desktop capabilities and Memory.

Tests live under `test/`. Run `bun run typecheck` and focused tests with isolated Homes, then root dependency and package checks.

Keep Session organization bindings in the registered domain schema. Validate immutable ownership and parent inheritance before transactional publication; ordinary import cannot grant organization ownership. Verify real storage, restart and unloaded-owner retention in `test/session-binding.test.ts`.

Compose through Agent Runtime with explicit features, exclusive sources and fixed gateway SDKs in both worker roles. Authorize from accepted Inbox/root evidence and current resource access, never enrollment alone. Keep scheduling and budgets native. Verify automatic execution, worker isolation and rejected preparation in the Runtime and execution-source suites.

Read local project configuration only through Harness `ProjectConfig` with an explicit field selection. Keep the permitted fields in the organization architecture and test selected values alongside excluded private settings. Never invoke the personal config loader to fill an absent organization value.

Provision member Homes by organization, account and device before Agent Runtime startup. Preserve established keys on retry; missing or mismatched credentials require explicit recovery. Registration tickets stay in memory, while public enrollment snapshots never replace current service authorization. Verify real HTTPS registration and response-loss retries in `test/enrollment.test.ts`; never disable TLS validation for deployment convenience.

Keep `./home` and `./registration` usable and typecheckable by Node provisioning hosts without importing the Agent lifecycle or Bun networking. Reuse Harness `HomeOwnershipFile`, bounded reads and the positive test-home guard before any provisioning write. Member HTTP uses the existing Server component with an explicit loopback port and per-instance bearer; verify real Node provisioning, failed-open cleanup and isolated HTTP instances in the Home and Runtime suites.

`member-runtime` consumes bounded private stdin and reuses CLI lifecycle. Its component contributes command discovery only; member source and worker selection belong to explicit Runtime opening. Hosts use `./environment` before spawning and disable implicit loader inputs. Preserve only the member Home's verified installation pin for workers; test source commands and installed launchers separately.

The outbound bridge declares implemented capabilities. Persist a matching epoch before returning; never lower it for a stale service snapshot. Preserve received errors through socket close, cancel checkpoint waits and drain admitted callbacks before disposal. Bounded commands cannot block heartbeats or reconciliation; saturation retains the connection. Verify real WSS fencing, liveness, capacity and drainage in `test/connection.test.ts`.

Resident bridges own resource clients. Preserve local readiness, stop reconnect on identity/protocol failure and drain calls before storage closes. One-shot discovery never connects. Follow [resource client rules](../../docs/architecture/organization.md#session-resources-and-execution-grants).

Validate the service's signing identity against the verified connection's organization and deployment before publishing its checkpoint. A matching key or valid signature does not bypass command, binding or transfer admission.

Separate logical effects from attempt/skip receipts; commit native effects atomically. Continue checks pause/version. Cancel publishes after commit and holds its lock through drainage. Observe activity separately; recheck binding/control version. Describe accepted resources before materialization; root proofs require canonical message/Run evidence and current fences. Verify rollback, restart and fencing in `test/command-intake.test.ts`; bind callbacks to their Runtime.

Desktop Browser selection requires explicit private launch data and a managed Desktop listener. Preserve both local HTTP and Browser registration authentication, reject inherited native credentials, and keep page creation lazy. Verify real sockets and rejected non-Desktop selection in `test/desktop.test.ts`.
