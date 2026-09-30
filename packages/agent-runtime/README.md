# Agent Runtime

Embed Synergy in Bun without cloning the repository. `home` is the data directory itself. Optional components are explicit; installed product presets do not change an embedded runtime.

```ts
import { openAgentRuntime } from "@ericsanchezok/synergy-agent-runtime"
import { localRuntime } from "@ericsanchezok/synergy-local-runtime/component"
import { lsp } from "@ericsanchezok/synergy-lsp/component"

await using runtime = await openAgentRuntime({
  home: "./.agent-data",
  components: [localRuntime({ workers: false }), lsp()],
})
const client = runtime.client({ directory: process.cwd() })
const session = await client.session.create({ title: "Embedded agent" })
```

The component list is required. An empty list opens the Harness without a default execution Environment or plugin host. Select `localRuntime({ workers: false, environment: false })` when native file services are needed without a default execution destination. Select the Plugin Host component separately if needed. Session creation and API tools do not allocate compute. See [Environments](../../docs/architecture/environments.md) for selection and lifetime. Components are checked for duplicate identities, missing dependencies, version conflicts and cycles before opening storage. Runtime close drains execution and disposes started services in reverse dependency order.
