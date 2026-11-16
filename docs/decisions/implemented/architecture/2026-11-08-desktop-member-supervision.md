# Decision Record: Desktop member process supervision

Status: implemented

## Problem

Desktop must supervise independently owned member processes without reusing personal configuration, ports or credentials. Bun-hosted tests alone cannot establish that the Electron main process can load the provisioning entry or supervise the actual member command. A second process manager would duplicate cancellation, readiness and termination behavior.

## Decision

`DesktopServerManager` accepts an explicit managed member profile. It validates the prepared Home before creating its own logs, uses member-owned port state, and starts the existing `member-runtime` command through the packaged launcher or an explicit source entry. Source launches disable implicit dotenv and Bun configuration loading. The shared member environment selector runs before spawn; Desktop adds only its owned parent, startup and launch metadata.

Each child attempt receives a fresh private bearer and a strict versioned request over stdin. Health polling uses that bearer. Main-owned connection data exposes it only to the owning caller; public status and process arguments omit it. Successful readiness discards the initial enrollment ticket. Restart preserves the member's port and durable identity while rotating its local credential. Start deduplication, generation cancellation, shutdown and failure handling reuse the existing manager.

Harness `HomeOwnershipFile` owns context-free metadata reading, matching and durable publication. Runtime-scoped `HomeOwnership` delegates to it, while Node provisioning uses it directly without importing Agent lifecycle types. Both paths retain the same record format, bounded reads and positive test-home guard. Provisioning checks isolation before creating its lock directory. Node consumer typechecking retains Node module resolution and excludes Bun ambient types.

Member Runtime opening accepts typed launch entry metadata. The CLI passes the entry selected by its existing host factory, preserving Desktop attribution without allowing personal environment inputs through the member selector.

## Alternatives considered

**Create a separate member supervisor.** This duplicates the established process state machine and risks different readiness, cancellation and termination behavior.

**Reuse personal ports and environment settings.** This can collide with the personal process or transfer private credentials and loader configuration into a member Home.

**Broaden Desktop typechecking to include the Bun runtime.** This conceals an import boundary problem and makes Node consumers depend on Agent execution types they do not use.

## Consequences

The manager can supervise multiple independent member children, with real Node-to-Bun startup and restart verification. Its personal maintenance and diagnostic commands are unavailable for member profiles because those commands do not select member ownership. Main-process connection registries, native capability routing and outbound bridge supervision remain their owning integrations; this process API does not itself enable Session execution.
