# Organization service

The organization service owns a dedicated Home and SQL namespace. Its storage lifecycle uses Harness transactions and the central migration runner without starting Agent execution, model discovery or Session recovery.

```ts
import { openOrganizationService } from "@ericsanchezok/synergy-organization/service"

await using service = await openOrganizationService({ home: "/absolute/organization-home" })
const server = Bun.serve({ hostname: "127.0.0.1", port: 4080, fetch: service.fetch, websocket: service.websocket })
// Stop the HTTP listener before disposing the service.
await server.stop(true)
```

The health endpoint is `/org/v1/health`. Clients use the independent `@ericsanchezok/synergy-sdk/organization` entry. See [organization architecture](../../docs/architecture/organization.md) for storage ownership.

The optional organization component contributes `synergy org init` and `synergy org serve` to the existing CLI. Enable its `organization` experiment in the dedicated Home's `config/synergy.d/140-features.jsonc` using the [feature selection format](../../docs/architecture/feature-lifecycle.md). Both commands require an explicit absolute `SYNERGY_HOME`; the component itself registers no service migrations in an Agent Runtime.

```bash
SYNERGY_HOME=/srv/synergy-org synergy org init --output /srv/org-bootstrap.json
SYNERGY_HOME=/srv/synergy-org synergy org serve --origin https://org.example.com --port 4080
```

`init` creates a mode-0600 file containing the one-time token and organization identity, and prints only JSON metadata. It refuses to overwrite an existing output file. Consume the token through the initialization API within 30 minutes and remove the token file after use. `serve` binds loopback by default behind the configured HTTPS reverse proxy. It prints JSON readiness with its actual listening URL, drains its service on SIGINT/SIGTERM and releases its Home lock. It does not initialize personal configuration, model providers or Agent execution. An explicitly set `SYNERGY_RUNTIME_ROOT` must match this Home's `.synergy` directory.

Set `publicOrigin` to the exact externally served HTTPS origin to enable browser identity routes. `service.bootstrapToken()` creates a short-lived initialization secret only before initialization; deliver it privately to the initializer. `/org/v1/setup/bootstrap` consumes it once. Login, invitation, password reset, account ownership and project endpoints are described by `packages/sdk/organization.openapi.json`. Initialization and invitation consumption use stable request IDs for explicit retry. The server stores token digests and password hashes; never log token responses or put them in project configuration.

Authentication settings control initialization (30 minutes), invitation (7 days), reset (30 minutes) and browser login (30 days) lifetimes. Password hashes use Argon2id with 64 MiB and time cost 3; the default service admits two simultaneous jobs and a bounded waiting queue. Project list APIs accept a cursor and a limit up to 100. Account and project mutations require the current revision. There is no destructive project-delete endpoint.

Member Runtime registration requires an authenticated account, a device ID and an Ed25519 public key. The returned registration ticket expires after 10 minutes and activates only the bound machine key through `/runtime/v1/register`. The generated organization client exposes registration, lookup, revocation and connection status. Private keys stay on the machine; tickets and signatures do not belong in URLs or logs.

Runtime machines connect through `/runtime/v1/connect` using an outbound WebSocket over the public TLS endpoint. Mount both `service.fetch` and `service.websocket` when embedding the service; `org serve` mounts them together. The first JSON frame must contain a signed connection proof. The bridge rejects browser cookies, Origin headers and query parameters. Defaults allow five seconds to authenticate, recommend heartbeats every ten seconds and mark the connection offline after thirty seconds of silence. Frame size is bounded to 64 KiB with bounded receive and send windows. Connection availability does not grant Session execution or transfer ownership.
