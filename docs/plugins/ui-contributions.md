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
| `ui.theme`           | packaged structured JSON theme                       |
| `ui.icon`            | packaged SVG icon                                    |

The host owns placement, lifecycle, Scope/Session binding, accessibility shell, and disposal. Each registration returns one disposer and is removed before reload.

## Trusted Components

Reference source TSX from the contribution:

```ts
workbenchPanel({
  id: "research-map",
  label: "Research map",
  surface: "side",
  cardinality: "multi",
  defaultResource: { id: "map", title: "Research map", state: { view: "map" } },
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
  surface: {
    kind: string
    id: string
    resource?: { id: string; title?: string; state?: JsonValue }
  }
  operations: {
    query(id: string, input?: unknown): Promise<unknown>
    command(id: string, input?: unknown): Promise<unknown>
  }
  events: {
    subscribe(eventId: string, listener: (event: unknown) => void): () => void
  }
  settings: {
    get(): Promise<Record<string, JsonValue>>
    subscribe(listener: (settings: Record<string, JsonValue>) => void): () => void
  }
  host: PluginUIHostActions
}
```

The operation client is bound to the component's own plugin. It can call only declared operations of the requested type. It never exposes a server URL or raw SDK client.

Use queries for complete snapshots and commands for intent. Subscribe to events to learn when a snapshot is stale, and dispose subscriptions during component cleanup. `settings` is read-only from the surface; changes continue to use the host-rendered settings page.

## Resource Tabs

`openWorkbenchPanel(panelId, resource)` preserves the opaque resource `id`, `title`, and JSON `state`. The host reuses an existing tab for the same `panelId + resource.id` and opens a separate tab for a different resource. The component reads the exact resource from `context.surface.resource`; it must not infer resource identity from a global variable or private route.

This supports one contribution with multiple stable views, such as a map, one tab per entity, and a diagnostics page. `defaultResource` is used when the workbench opens the panel without an explicit resource.

## Declarative Settings

Object-form settings are rendered with the host's design system. Boolean fields use `SettingRow` and `Switch`; strings, numbers, and enums use host form controls and semantic tokens. The schema's top-level description is shown as page help. Saves are optimistic and roll back with a host notification if persistence fails. A plugin component should not reproduce the settings page chrome or form layout.

## Host Actions

With approved `ui.hostActions`, trusted UI may call:

- `openSession(sessionId)`
- `openPluginPage(path, params?)`
- `openWorkbenchPanel(panelId, resource?)`
- `openResource({ kind: 'artifact' | 'file', uri })`
- `notify(message, options?)`
- `confirm(options)`

Without that capability these calls fail. Prefer host actions over constructing Synergy routes or reaching into private app contexts.

## Themes and Icons

Themes and icons are host-rendered data contributions. They do not execute plugin UI code:

```ts
import { definePlugin, icon, theme } from "@ericsanchezok/synergy-plugin"

export default definePlugin({
  id: "ocean-theme",
  version: "1.0.0",
  description: "Ocean theme",
  contributions: [
    theme({ id: "ocean", label: "Ocean", path: "themes/ocean.json" }),
    icon({ id: "logo", path: "icons/logo.svg" }),
  ],
})
```

Theme JSON contains `name`, an `id` equal to the contribution ID, and complete `light.seeds` and `dark.seeds`. Each seed set defines `neutral`, `primary`, `success`, `warning`, `error`, `info`, `interactive`, `diffAdd`, and `diffDelete` as opaque hex colors. Optional `overrides` may address only canonical theme tokens. The host validates and resolves both variants before registration; arbitrary CSS, unknown tokens, cyclic references, and invalid contrast are rejected.

The host namespaces theme and icon IDs as `<plugin-id>:<contribution-id>`. Surface `icon` fields continue to use the plugin-local contribution ID; the host resolves it to the namespaced registered icon. Assets are fetched and validated before an atomic reload replaces the previous generation.

## Scope and Reload

The Web host fetches contributions for the active Scope. Switching Scope rebuilds registrations with a new context. Runtime generations and asset URLs include the generation so stale bundles are not reused. A failure in one surface is reported for that contribution and does not remove unrelated plugin contributions.
