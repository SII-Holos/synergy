# Organization service

The organization service owns a dedicated Home and SQL namespace. Its storage lifecycle uses Harness transactions and the central migration runner without starting Agent execution, model discovery or Session recovery.

```ts
import { openOrganizationService } from "@ericsanchezok/synergy-organization/service"

await using service = await openOrganizationService({ home: "/absolute/organization-home" })
const server = Bun.serve({ hostname: "127.0.0.1", port: 4080, fetch: service.fetch })
// Stop the HTTP listener before disposing the service.
await server.stop(true)
```

The health endpoint is `/org/v1/health`. Clients use the independent `@ericsanchezok/synergy-sdk/organization` entry. See [organization architecture](../../docs/architecture/organization.md) for storage ownership.

Set `publicOrigin` to the exact externally served HTTPS origin to enable browser identity routes. `service.bootstrapToken()` creates a short-lived initialization secret only before initialization; deliver it privately to the initializer. `/org/v1/setup/bootstrap` consumes it once. Login, invitation, password reset, account ownership and project endpoints are described by `packages/sdk/organization.openapi.json`. Initialization and invitation consumption use stable request IDs for explicit retry. The server stores token digests and password hashes; never log token responses or put them in project configuration.

Authentication settings control initialization (30 minutes), invitation (7 days), reset (30 minutes) and browser login (30 days) lifetimes. Password hashes use Argon2id with 64 MiB and time cost 3; the default service admits two simultaneous jobs and a bounded waiting queue. Project list APIs accept a cursor and a limit up to 100. Account and project mutations require the current revision. There is no destructive project-delete endpoint.
