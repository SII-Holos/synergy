# Agent Runtime

Embed Synergy in Bun without cloning the repository. `home` is the data directory itself. Optional components are explicit; installed product presets do not change an embedded runtime.

Embedded control planes register `SessionExecutionSource` from Harness `session/execution-source` in their selected component. Its authority check runs before Session loop admission, including Cortex children and automatic wakes. Denied work stays in the Inbox until an explicitly authorized drive; hosts still fence and drain active work when authority expires. Use `mode: "oneshot"` for a long-lived worker with host-controlled recovery and resident services. Recording reconciliation under namespace ownership remains part of core startup.

Register `ProviderCatalogSource` for an exclusive host model inventory and `ProviderRequestSource` for ephemeral per-invocation connection preparation. Request keys, headers and JSON SDK context reach the worker plan after model parameter assembly. The host validates the detached root user metadata and supplies an explicit `ProviderSdkSource` factory; request credentials must not be placed in the stable catalog or model options.

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
