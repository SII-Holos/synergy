# Plugin UI Contributions

Synergy supports two UI paths: host-rendered declarations and user-approved trusted Solid components. There is no iframe tier or generic low-code UI DSL.

## Contribution Kinds

| Kind                 | Purpose                                              |
| -------------------- | ---------------------------------------------------- |
| `ui.workbenchPanel`  | side or bottom workbench surface                     |
| `ui.navigationItem`  | sidebar or plugin page destination                   |
| `ui.messageRenderer` | renderer for a declared message type                 |
| `ui.composerAction`  | component in a declared composer slot                |
| `ui.settings`        | schema-driven settings and optional custom component |
| `ui.theme`           | packaged CSS theme                                   |
| `ui.icon`            | packaged SVG icon                                    |

The host owns placement, lifecycle, Scope/Session binding, accessibility shell, and disposal. Each registration returns one disposer and is removed before reload.

## Trusted Components

Reference source TSX from the contribution:

```ts
workbenchPanel({
  id: "research-map",
  label: "Research map",
  surface: "side",
  cardinality: "singleton",
  component: { source: "./src/ui/research-map.tsx" },
})
```

The component exports a Solid component that receives `{ context: PluginSurfaceContext }` in source templates. plugin-kit compiles all trusted components into one named-export UI bundle, externalizes `solid-js`, `solid-js/web`, and `solid-js/store`, rewrites those imports to the host's shared runtime, and records the bundle hash. Bundles that include a private Solid runtime, use unsupported Solid subpaths, bypass host linking, or omit an export are rejected.

Trusted code runs in the Synergy App context after explicit approval. This is a trust decision, not a sandbox claim.

## Surface Context

```ts
interface PluginSurfaceContext {
  pluginId: string
  scopeId: string
  sessionId?: string
  surface: { kind: string; id: string }
  operations: {
    query(id: string, input?: unknown): Promise<unknown>
    command(id: string, input?: unknown): Promise<unknown>
  }
  events: {
    subscribe(eventId: string, listener: (event: unknown) => void): () => void
  }
  host: PluginUIHostActions
}
```

The operation client is bound to the component's own plugin. It can call only declared operations of the requested type. It never exposes a server URL or raw SDK client.

Use queries for complete snapshots and commands for intent. Subscribe to events to learn when a snapshot is stale, and dispose subscriptions during component cleanup.

## Host Actions

With approved `ui.hostActions`, trusted UI may call:

- `openSession(sessionId)`
- `openPluginPage(path, params?)`
- `openWorkbenchPanel(panelId, resource?)`
- `openResource({ kind: 'artifact' | 'file', uri })`
- `notify(message, options?)`
- `confirm(options)`

Without that capability these calls fail. Prefer host actions over constructing Synergy routes or reaching into private app contexts.

## Scope and Reload

The Web host fetches contributions for the active Scope. Switching Scope rebuilds registrations with a new context. Runtime generations and asset URLs include the generation so stale bundles are not reused. A failure in one surface is reported for that contribution and does not remove unrelated plugin contributions.
