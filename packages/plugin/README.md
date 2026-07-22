# Synergy Plugin API 3

`definePlugin()` is the only source of plugin identity, capabilities, contributions, and executable handlers. Authors do not write `plugin.json`; `synergy-plugin build` generates it with runtime/UI bundles and integrity metadata.

```ts
import z from "zod"
import { capability, definePlugin, event, operation, workbenchPanel } from "@ericsanchezok/synergy-plugin"

export default definePlugin({
  id: "example",
  version: "1.0.0",
  description: "Example plugin",
  assets: [{ source: "src/prompts", target: "runtime/prompts" }],
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
- Top-level `assets` map project-relative files or directories into package-relative targets. Asset contents are integrity-checked and included in the generation hash.

## Contribution Factories

Executable factories: `operation`, `tool`, `hook`, `cliCommand`, `authProvider`, `lifecycleUpgrade`, and `lifecycleUninstall`.

Declarative factories: `event`, `agent`, `skill`, `mcp`, `workbenchPanel`, `navigationItem`, `messageRenderer`, `composerAction`, `composerExtension`, `selectionExtension`, `textAction`, `messageSlot`, `settings`, `theme`, and `icon`.

The generated manifest contains declarations only. Runtime startup reports its actual handler IDs, and the host requires an exact match.

## Invocation Context

Every executable call receives a fresh `PluginInvocationContext` with request ID, Scope, optional Session, actor, cancellation, logger, scoped events, and only the Host Services allowed by approved capabilities. Plugins never receive a raw Synergy client, server URL, or token.

Capabilities govern Host Services; they do not claim to restrict direct OS access by the external process. `task.delegate` exposes `start/run/current/get/cancel`; `run()` waits for a native Cortex Task and returns its terminal snapshot, while `current()` reads the durable owner of the invoking child Session. Non-agent callers must provide an explicit parent Session/message for `start()` in the active Scope. Contributed Agents are registered in Synergy's native Agent registry. Set `hidden: true` for an owner-only Agent that must stay out of ordinary prompt and native-task exposure.

`asset.write` exposes `context.asset.create()` and returns a host-owned attachment. `shell.execute` exposes argv-only `context.shell.run()` through the ordinary permission and sandbox boundary. `cliCommand()` registers executable commands under `synergy <pluginId> <command>`. MCP contributions use strict shared local/remote schemas and are installed atomically under qualified `${pluginId}::${contributionId}` names.

`task.delegate` is the plugin capability; `task` is the separate runtime permission evaluated by the current control profile. `task.start()` parent binding failures expose `PluginHostServiceErrorCode.TASK_PARENT_REQUIRED` or `TASK_PARENT_SCOPE_MISMATCH`. Host Service error codes survive process IPC.

`agent.call` exposes a bounded Sessionless Agent call only to an executable contribution that lists it in `requires`. By default a plugin may call only a hidden Agent owned by its active generation; capability constraints may allow additional Agent names and lower the host runtime/input/output ceilings. The call has no tools, Session history, or Cortex lifecycle.

## Trusted UI

Trusted Solid components receive `PluginSurfaceContext`. The component uses bound `operations.query/command`, scoped `events.subscribe`, settings `get/subscribe`, capability-gated `settings.replace`, and capability-gated host actions. plugin-kit compiles TSX and binds `solid-js`, `solid-js/web`, and `solid-js/store` to the host runtime; plugins must not ship a private Solid runtime.

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
