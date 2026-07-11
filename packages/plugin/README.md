# Synergy Plugin API 3

`definePlugin()` is the only source of plugin identity, capabilities, contributions, and executable handlers. Authors do not write `plugin.json`; `synergy-plugin build` generates it with runtime/UI bundles and integrity metadata.

```ts
import z from "zod"
import { capability, definePlugin, event, operation, workbenchPanel } from "@ericsanchezok/synergy-plugin"

export default definePlugin({
  id: "example",
  version: "1.0.0",
  description: "Example plugin",
  capabilities: [capability("workspace.read"), capability("ui.hostActions")],
  contributions: [
    event({ id: "example.changed", payload: z.object({ reason: z.string() }) }),
    operation({
      id: "example.get",
      type: "query",
      input: z.object({}),
      output: z.object({ scopeId: z.string() }),
      async handler(_input, context) {
        return { scopeId: context.scopeId }
      },
    }),
    workbenchPanel({
      id: "main",
      label: "Example",
      surface: "side",
      cardinality: "singleton",
      component: { source: "./src/ui.tsx" },
    }),
  ],
})
```

## Definition Rules

- Plugin IDs use lowercase letters, digits, dots, and hyphens and begin with a letter.
- Contribution IDs are unique across the whole plugin.
- A contribution's `requires` entries must exist in top-level `capabilities`.
- `operation()` defaults to `expose: ['ui']`; add `sdk` explicitly for public SDK access.
- Zod and JSON Schema are accepted for operation, event, and tool schemas.
- `activate()` runs once per runtime generation and does not receive Scope or Session state.

## Contribution Factories

Executable factories: `operation`, `tool`, `hook`, `authProvider`, `lifecycleUpgrade`, and `lifecycleUninstall`.

Declarative factories: `event`, `agent`, `skill`, `mcp`, `workbenchPanel`, `navigationItem`, `messageRenderer`, `composerAction`, `settings`, `theme`, and `icon`.

The generated manifest contains declarations only. Runtime startup reports its actual handler IDs, and the host requires an exact match.

## Invocation Context

Every executable call receives a fresh `PluginInvocationContext` with request ID, Scope, optional Session, actor, cancellation, logger, scoped events, and only the Host Services allowed by approved capabilities. Plugins never receive a raw Synergy client, server URL, or token.

Capabilities govern Host Services; they do not claim to restrict direct OS access by the external process. `task.run` and `tool.invoke` additionally require an agent invocation context.

## Trusted UI

Trusted Solid components receive `PluginSurfaceContext`. The component uses bound `operations.query/command`, scoped `events.subscribe`, and capability-gated host actions. plugin-kit compiles TSX and binds `solid-js`, `solid-js/web`, and `solid-js/store` to the host runtime; plugins must not ship a private Solid runtime.

Source component shape:

```tsx
import type { Component } from "solid-js"
import type { PluginSurfaceContext } from "@ericsanchezok/synergy-plugin/ui"

const Panel: Component<{ context: PluginSurfaceContext }> = (props) => (
  <section aria-label={props.context.surface.id}>Plugin content</section>
)

export default Panel
```

## Runtime and Data

External plugins run in one process per active `pluginId + version + generation`; enabled Scopes share it and receive separate invocation contexts. Trusted built-ins may use `inProcess`. The process boundary is crash/resource cleanup isolation, not an OS security sandbox.

Plugins own their business data, schema, concurrency, backup, migration, and deletion. Synergy stores only installation metadata, approval, Scope enablement, declarative settings, and plugin credentials.

## Toolchain

```bash
synergy-plugin build
synergy-plugin validate --runtime-discovery
synergy-plugin test
synergy-plugin pack
synergy-plugin dev --server-url http://127.0.0.1:PORT
```

Live reload requires an explicit isolated `SYNERGY_HOME`. Successful rebuilds publish a new generation atomically; failed builds leave the previous generation active.

See [`docs/plugins`](../../docs/plugins/README.md) for architecture, lifecycle, marketplace, security, and UI guidance.
