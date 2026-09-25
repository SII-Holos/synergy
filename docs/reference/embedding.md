# Embed Synergy

Use Bun for an in-process agent and the HTTP SDK for Node.js or an existing service. Each runtime owns an explicit data directory. Embedding selects its components explicitly and does not inherit components from a user's installation.

## Bun

```ts
import { openAgentRuntime } from "@ericsanchezok/synergy-agent-runtime"
import { mcp } from "@ericsanchezok/synergy-mcp/component"
import { lsp } from "@ericsanchezok/synergy-lsp/component"

await using runtime = await openAgentRuntime({
  home: "./.agent-data",
  components: [mcp(), lsp()],
})
const client = runtime.client({ directory: process.cwd() })
```

`home` is the data directory itself. Local execution and the process plugin host are included. HTTP, Browser, Library and other optional domains require their component factories. The component graph validates versions and dependencies before opening storage. See the [Agent Runtime API](../../packages/agent-runtime/README.md) for session execution.

## Node.js

The SDK manages a separate Bun runtime process or attaches to an existing HTTP service. It does not run the Harness inside Node.js.

```ts
import { createSynergy } from "@ericsanchezok/synergy-sdk"

const { client, server } = await createSynergy({
  mode: "managed",
  executable: process.env.SYNERGY_EXECUTABLE!,
  version: process.env.SYNERGY_VERSION!,
  home: "./.agent-data",
  components: { server: process.env.SYNERGY_VERSION! },
  client: { directory: process.cwd() },
})
try {
  const capabilities = await client.global.capabilities()
  console.log(capabilities.data?.components)
} finally {
  await server.close()
}
```

Supply the absolute installed executable path and exact host/component versions. Components must already be installed. `args` supplies executable-prefix arguments when explicitly running a source or module entry. The SDK uses a dynamic loopback port by default, gives the child a private bearer credential through its environment, and checks the versioned readiness record's process ID, version, home, endpoint and requested components. It does not parse a human startup banner. Timeout, abort and failed readiness drain only the process it created; `close()` is asynchronous and idempotent.

To attach to a running service:

```ts
const { client, server } = await createSynergy({
  mode: "attach",
  url: "http://127.0.0.1:4096",
  headers: { authorization: `Bearer ${process.env.SYNERGY_TOKEN}` },
  client: { scopeID: "home" },
})
await server.close() // The attached service remains running.
```

Caller fetch implementations, headers and Scope selectors remain supported. HTTP clients for other languages can consume [OpenAPI](../../packages/sdk/openapi.json); session-owned operations must keep the same explicit directory or Scope selector as the TypeScript client.

## Runtime capabilities

`GET /global/capabilities` reports the active component IDs, versions and component API versions for this runtime. Use the generated `client.global.capabilities()` method before calling optional APIs. The endpoint requires no project Scope. Installed changes take effect at the next runtime start; the active response never claims that a newly installed component is already running. Component availability is distinct from permission approval.

Managed SDK processes require the private bearer credential on HTTP requests. Existing service deployments retain their configured transport/authentication boundary; attaching does not create or replace credentials.

The Web application discovers this selection before optional requests. Navigation, settings, composer mechanisms and workbench panels follow the active components; reconnecting replaces the previous selection. A Web client can therefore attach to a core server or a selected subset without polling absent component routes.
