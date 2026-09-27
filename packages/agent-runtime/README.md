# Agent Runtime

Embed Synergy in Bun without cloning the repository. `home` is the data directory itself. Optional components are explicit; installed product presets do not change an embedded runtime.

```ts
import { openAgentRuntime } from "@ericsanchezok/synergy-agent-runtime"
import { lsp } from "@ericsanchezok/synergy-lsp/component"

await using runtime = await openAgentRuntime({ home: "./.agent-data", components: [lsp()] })
const client = runtime.client({ directory: process.cwd() })
const session = await client.session.create({ title: "Embedded agent" })
```

The core includes local execution and the process plugin host. Components are checked for duplicate identities, missing dependencies, version conflicts and cycles before opening storage. Runtime close drains execution and disposes started services in reverse dependency order.
