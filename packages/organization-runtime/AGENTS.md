# Organization Runtime Adapter

Own the Runtime's organization binding, trusted bridge, command receiver, synchronization exporter and remote resource adapters. Identity and project authorization belong to the organization service; this package verifies service identity and execution epochs and preserves actor attribution without maintaining user role tables.

Use Harness execution owners and Inbox; never create another scheduler. Personal configuration, credentials and global Skill sources cannot leak into organization compositions. Keep hosted execution free of native Desktop capabilities and Memory.

Tests live under `test/`. Run `bun run typecheck` and focused tests with isolated Homes, then root dependency and package checks.

Keep Session organization bindings in the registered domain schema. Validate immutable ownership and parent inheritance before transactional publication; ordinary import cannot grant organization ownership. Verify real storage, restart and unloaded-owner retention in `test/session-binding.test.ts`.

Compose through Agent Runtime with explicit features and exclusive sources. Register member identity and source selection in both worker roles. Keep execution denied until trusted command admission is available; enrollment and bridge availability do not authorize work. Verify personal/A/B source separation and actual workers in `test/runtime.test.ts`.

Read local project configuration only through Harness `ProjectConfig` with an explicit field selection. Keep the permitted fields in the organization architecture and test selected values alongside excluded private settings. Never invoke the personal config loader to fill an absent organization value.

Provision member Homes by organization, account and device before Agent Runtime startup. Preserve established keys on retry; missing or mismatched credentials require explicit recovery. Registration tickets stay in memory, while public enrollment snapshots never replace current service authorization. Verify real HTTPS registration and response-loss retries in `test/enrollment.test.ts`; never disable TLS validation for deployment convenience.

Keep `./home` and `./registration` usable and typecheckable by Node provisioning hosts without importing the Agent lifecycle or Bun networking. Reuse Harness `HomeOwnershipFile`, bounded reads and the positive test-home guard before any provisioning write. Member HTTP uses the existing Server component with an explicit loopback port and per-instance bearer; verify real Node provisioning, failed-open cleanup and isolated HTTP instances in the Home and Runtime suites.

The owner-initialized `member-runtime` command consumes bounded private stdin and reuses CLI server lifecycle. Its component contributes command discovery only; member source and worker selection belong to explicit Runtime opening. Hosts use `./environment` before spawning and disable implicit loader inputs. Preserve only the member Home's verified installation pin for workers; test source commands and installed launchers separately.

The outbound bridge declares only implemented capabilities. Persist a matching acknowledged epoch before returning a connected handle; never lower a checkpoint to satisfy a stale service snapshot. Preserve received protocol errors through socket close, propagate cancellation into checkpoint lock waits and drain pending writes before disposal. Verify real WSS fencing, reconnection, revocation and failure paths in `test/connection.test.ts`.

Resident connections belong to component services. Keep local readiness independent of the remote service, stop reconnect on replacement or authorization/protocol failure, and drain connection work on Runtime close. One-shot discovery never starts a bridge.

Validate the service's signing identity against the verified connection's organization and deployment before publishing its checkpoint. A matching key or valid signature does not bypass command, binding or transfer admission.

Desktop Browser selection requires explicit private launch data and a managed Desktop listener. Preserve both local HTTP and Browser registration authentication, reject inherited native credentials, and keep page creation lazy. Verify real sockets and rejected non-Desktop selection in `test/desktop.test.ts`.
