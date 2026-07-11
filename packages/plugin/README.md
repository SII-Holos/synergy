# Synergy Plugin API 3

`definePlugin()` is the only source of plugin identity, capabilities, declarations, and executable handlers. Authors do not write `plugin.json`; `synergy-plugin build` generates it together with the runtime and trusted UI bundles.

```ts
import { capability, definePlugin, event, operation, workbenchPanel } from "@ericsanchezok/synergy-plugin"

export default definePlugin({
  id: "example",
  version: "1.0.0",
  description: "Example plugin",
  capabilities: [capability("workspace.read"), capability("ui.hostActions")],
  contributions: [
    event({ id: "example.changed", payload: { type: "object" } }),
    operation({
      id: "example.get",
      type: "query",
      input: { type: "object", additionalProperties: false },
      output: { type: "object" },
      async handler(_input, context) {
        return { scopeId: context.scopeId }
      },
    }),
    workbenchPanel({
      id: "main",
      label: "Example",
      surface: "side",
      cardinality: "singleton",
      component: { source: "src/ui/main.tsx" },
    }),
  ],
})
```

Contributions form one flat discriminated union. Executable kinds are `operation`, `tool`, `hook`, `authProvider`, `lifecycle.upgrade`, and `lifecycle.uninstall`. Declarative kinds include agents, skills, MCP servers, settings, navigation, themes, icons, and UI surfaces.

External plugins run in one process per active `pluginId + version + generation`. Multiple Scopes share that runtime; every invocation receives a fresh Scope/Session context. The process boundary isolates crashes and resource cleanup and is not an OS security sandbox.

Capabilities only control Synergy Host Services. They do not claim to restrict direct OS access by the plugin process. Plugins own their business data, schema, backup, migration, and deletion. Synergy stores only installation metadata, approvals, Scope enablement, declarative settings, and plugin secrets.

Complex UI is a trusted Solid component loaded only after user approval. It receives `PluginSurfaceContext`, whose operation client is bound to its own plugin identity. Complete state comes from query operations; events are small invalidation/state-change notifications.

Toolchain:

```sh
synergy-plugin build
synergy-plugin validate
synergy-plugin pack
synergy-plugin dev --server-url http://127.0.0.1:PORT
```

Live development must use an isolated `SYNERGY_HOME`. A successful rebuild publishes a new generation atomically; failed builds leave the previous generation active.
