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
