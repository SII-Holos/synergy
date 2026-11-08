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

The dedicated Home retains an ownership marker through the central migration runner. It cannot be started as a personal Agent Runtime, and initial organization setup refuses a Home containing personal Runtime data. Preserve the marker with the rest of the Home when copying it.

The optional organization component contributes `synergy org init` and `synergy org serve` to the existing CLI. Enable its `organization` experiment in the dedicated Home's `config/synergy.d/140-features.jsonc` using the [feature selection format](../../docs/architecture/feature-lifecycle.md). Both commands require an explicit absolute `SYNERGY_HOME`; the component itself registers no service migrations in an Agent Runtime.

```bash
SYNERGY_HOME=/srv/synergy-org synergy org init --output /srv/org-bootstrap.json
SYNERGY_HOME=/srv/synergy-org synergy org serve --origin https://org.example.com --port 4080
```

`init` creates a mode-0600 file containing the one-time token and organization identity, and prints only JSON metadata. It refuses to overwrite an existing output file. Consume the token through the initialization API within 30 minutes and remove the token file after use. `serve` binds loopback by default behind the configured HTTPS reverse proxy. It prints JSON readiness with its actual listening URL, drains its service on SIGINT/SIGTERM and releases its Home lock. It does not initialize personal configuration, model providers or Agent execution. An explicitly set `SYNERGY_RUNTIME_ROOT` must match this Home's `.synergy` directory.

Set `publicOrigin` to the exact externally served HTTPS origin to enable browser identity routes. `service.bootstrapToken()` creates a short-lived initialization secret only before initialization; deliver it privately to the initializer. `/org/v1/setup/bootstrap` consumes it once. Login, invitation, password reset, account ownership and project endpoints are described by `packages/sdk/organization.openapi.json`. Initialization and invitation consumption use stable request IDs for explicit retry. The server stores token digests and password hashes; never log token responses or put them in project configuration.

Authentication settings control initialization (30 minutes), invitation (7 days), reset (30 minutes) and browser login (30 days) lifetimes. Password hashes use Argon2id with 64 MiB and time cost 3; the default service admits two simultaneous jobs and a bounded waiting queue. Project list APIs accept a cursor and a limit up to 100. Account and project mutations require the current revision. There is no destructive project-delete endpoint.

Embedding callers register allowed clients through `clientAuthentication.clients` when opening the service. The `org` commands read the same settings from the global `organization` domain in `config/synergy.d/150-organization.jsonc` within the dedicated Home's `.synergy` root. They read this file only, without personal, project, legacy or environment configuration discovery and without file/env interpolation. Settings are validated before opening the service or creating an initialization token file; invalid files remain in place and errors omit their content. Restart the service after edits. See [configuration layout](../../docs/reference/configuration-layout.md#organization-service-settings).

Each registered client has a unique `clientID`, a `kind` of `web` or `desktop`, and an exact `redirectUri`. Web callbacks require HTTPS without credentials, query or fragment; the Desktop callback is `synergy://organization-auth/callback`. No clients are enabled implicitly. Discovery and the generated `orgAuth.authorize`, `exchange` and `refresh` methods expose the authorization exchange. Only a first-party login with CSRF can authorize a client; the exchange requires S256 PKCE. API callers pass the access token as an `Authorization: Bearer` header. Desktop's `orgAuth.revoke` accepts its original refresh credential to revoke the originating login, including after an uncertain rotation; it is idempotent and issues no new credentials.

Client settings default to 60-second codes, 15-minute access tokens and 30-day Desktop refresh grants; each can be shortened with `codeMs`, `accessMs` and `refreshMs`. A grant cannot outlive its originating login. Web clients receive no refresh token. Desktop refresh tokens rotate once and concurrent or repeated use revokes their whole grant, so callers must serialize refresh. Changing a callback or removing a client invalidates prior authorization. Cross-origin browser requests allow registered Web callback origins without credentialed cookies.

The Web build includes a separate `organization.html` authorization and callback entry. Pass `--web /absolute/web-dist` to `org serve`, or `web: { directory }` to programmatic startup, to serve that page and its local assets without opening an Agent Runtime. Register the Web client’s exact HTTPS `organization.html` URL as its callback. The organization’s first-party page reuses a valid login, displays the account and destination, and requires Continue before issuing a code. Its resource policy permits only its own scripts and connections; the hosting Web client’s `connect-src` policy must explicitly permit the organization origin. Preserve the authorization page’s opener policy through the reverse proxy so cross-origin popup callbacks remain connected. See [organization architecture](../../docs/architecture/organization.md) for transaction and recovery ownership.

For the hosted Web app, add the organization origin to `server.webConnectOrigins` in its global `config/synergy.d/120-runtime.jsonc`, then reload the page. Values must be exact HTTPS origins, without a path, wildcard or credentials; project configuration cannot expand this list. The static owner publishes the same list into the page and its connection policy. Use **Connect organization** in the existing space menu and enter the registered client ID. Desktop uses its native authorization bridge and accepts an explicitly entered HTTPS organization address. Account recovery validates the previous organization, account and deployment; connecting another account creates a separate identity.

The project view reads the service’s authorized pages and current roles. Organization views remain available while the personal Runtime is offline. Web reload requires an explicit authorization window, reusing the organization’s valid first-party login; only public connection descriptions are persisted. Sign-out clears the selected identity’s controlled caches before contacting the service and retains a pending action after failure. An expired or already revoked access token can only revoke its originating login, so a lost logout response can be retried without signing in again. After browser memory is lost, finishing a pending logout uses an explicit authorization window for the same account. See the [space lifecycle decision](../../docs/decisions/implemented/architecture/2026-11-08-organization-space-lifecycle.md).

Member Runtime registration requires an authenticated account, a device ID and an Ed25519 public key. The returned registration ticket expires after 10 minutes and activates only the bound machine key through `/runtime/v1/register`. The generated organization client exposes registration, lookup, revocation and connection status. Private keys stay on the machine; tickets and signatures do not belong in URLs or logs.

Runtime machines connect through `/runtime/v1/connect` using an outbound WebSocket over the public TLS endpoint. Mount both `service.fetch` and `service.websocket` when embedding the service; `org serve` mounts them together. The first JSON frame must contain a signed connection proof. The bridge rejects browser cookies, Origin headers and query parameters. Defaults allow five seconds to authenticate, recommend heartbeats every ten seconds and mark the connection offline after thirty seconds of silence. Frame size is bounded to 64 KiB with bounded receive and send windows. Connection availability does not grant Session execution or transfer ownership.
