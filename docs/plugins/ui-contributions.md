# Plugin UI Contributions

Synergy supports two UI paths: host-rendered declarations and user-approved trusted Solid components. There is no iframe tier or generic low-code UI DSL.

## Contribution Kinds

| Kind                    | Purpose                                                     |
| ----------------------- | ----------------------------------------------------------- |
| `ui.workbenchPanel`     | side or bottom workbench surface                            |
| `ui.navigationItem`     | sidebar or plugin page destination                          |
| `ui.messageRenderer`    | renderer for a declared message type or one owned Tool card |
| `ui.composerAction`     | component in a declared composer slot                       |
| `ui.settings`           | schema-driven settings and optional custom component        |
| `ui.theme`              | packaged structured JSON theme                              |
| `ui.icon`               | packaged SVG icon                                           |
| `ui.composerExtension`  | headless lifecycle for Composer document services           |
| `ui.selectionExtension` | headless lifecycle for settled selected text                |
| `ui.textAction`         | host-rendered action for the selected-text menu             |
| `ui.messageSlot`        | additive content around canonical messages                  |
| `ui.slot`               | trusted component in a host-declared surface position       |

The host owns placement, lifecycle, Scope/Session binding, accessibility shell, and disposal. Each registration returns one disposer and is removed before reload.

## Slots

`slot()` contributes a trusted component into a host-declared surface position. The host owns the slot vocabulary: a contribution targeting an undeclared slot is rejected with a contribution error, so the slot list below is the contract.

```ts
import { definePlugin, slot } from "@ericsanchezok/synergy-plugin"

export default definePlugin({
  id: "status-widget",
  version: "1.0.0",
  description: "Status widget",
  contributions: [
    slot({
      id: "status",
      slot: "sidebar.footer",
      label: "Status",
      component: { source: "./src/ui.tsx" },
    }),
  ],
})
```

Declared host slots (v1):

| Slot                     | Location                      | Notes                                            |
| ------------------------ | ----------------------------- | ------------------------------------------------ |
| `settings.section`       | settings content area         | appended below the active section                |
| `sidebar.footer`         | sidebar bottom                | below the agent hub                              |
| `session.header.actions` | session top bar right actions | `when: { session: true }` gates to open sessions |
| `session.empty`          | empty conversation state      | fallback keeps the built-in empty state          |
| `app.footer`             | app shell footer              | global footer                                    |

The component receives `PluginSlotSurfaceContext` (the same `PluginSurfaceContext` contract). An optional `when: { session: boolean }` condition hides the entry unless the outlet reports the matching session context; a `session.header.actions` contribution typically sets `when: { session: true }` so it only appears inside an open session.

A slot is a render position, so `component` is required — a contribution without a trusted component is rejected. If a slot's component fails to load or render, the host renders the shared plugin error card in that slot position instead of leaving it blank.

Styling a surface (for example a parchment or brushed-metal footer) is done with the component's own CSS: plugin-kit extracts imported stylesheets into the plugin's `ui/index.css`, the host injects it as a `<link>` on registration, and selectors are namespaced by your own class names — prefix them with the plugin ID to avoid collisions. The theme color contract is not extended for surfaces; colors come from the theme's semantic tokens and surfaces are component-owned.

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

The component exports a Solid component that receives `{ context: PluginSurfaceContext }` in source templates. plugin-kit compiles all trusted components into one named-export UI bundle, externalizes `solid-js`, `solid-js/web`, and `solid-js/store`, rewrites those imports to the host's shared runtime, and records the bundle hash. The plugin-kit CLI and standalone Synergy runtime include the compiler, so plugin projects do not install Babel presets. Bundles that include a private Solid runtime, use unsupported Solid subpaths, bypass host linking, or omit an export are rejected.

Components may import CSS from the plugin project. plugin-kit extracts imported stylesheets into a sibling `ui/index.css` next to the UI bundle; the host injects that stylesheet as a `<link>` when the plugin surfaces are registered and removes it on reload, disable, or uninstall. CSS is bundled and namespaced only by the plugin author's own class names; the host does not rewrite selectors. Keep selectors prefixed with the plugin ID to avoid collisions with the host or other plugins. Assets referenced from CSS (for example `url(...)` images) are inlined as data URLs or emitted as hashed sibling assets next to the stylesheet; relative URLs resolve against the stylesheet's asset URL, so no extra declaration is required.

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
    replace(values: Record<string, JsonValue>): Promise<void>
    subscribe(listener: (settings: Record<string, JsonValue>) => void): () => void
  }
  host: PluginUIHostActions
}
```

The operation client is bound to the component's own plugin. It can call only declared operations of the requested type. It never exposes a server URL or raw SDK client.

Use queries for complete snapshots and commands for intent. Subscribe to events to learn when a snapshot is stale, and dispose subscriptions during component cleanup. `settings.get()` and `subscribe()` are always bound to the component's plugin and Scope. `settings.replace()` is available only when `settings.write` was approved; it persists the complete settings object through the generated client and publishes the scoped settings change.

## Composer Extensions

`composerExtension()` mounts one headless trusted component for each active Composer. Its specialized context provides the host-owned Composer document service. `composer.read` permits immutable revision/text/selection snapshots and the 700 ms settled hook; `composer.write` permits suffix completion, decorations, and revision-checked edits; `composer.intercept` permits the serial normal-message preflight hook.

Completion inserts only after a collapsed caret. Decorations annotate existing ranges without editing them. `applyEdits()` performs the actual replacement and rejects stale revisions, overlapping/out-of-range edits, and file-pill crossings. A preflight callback returns only `Promise<void>`: a plugin may open its own workbench panel and await its own operation/event protocol, but Synergy defines no review result or language-specific state.

Draft callbacks run in parallel after IME composition settles. Preflight callbacks run serially in contribution order and the next callback reads the previous callback's edits. Shell, commands, and workflow start actions do not enter this Web-only preflight path.

## Selection and Text Actions

`selectionExtension()` receives the immutable selected-text snapshot after the active selection has remained stable for 250 ms. The snapshot includes a host-generated `selectionId`, text, `document | code | terminal` source, `user_message | assistant_message | editable | other` origin, and editable/whole-container flags. Password, credential, explicitly excluded, and oversized selections are not distributed. DOM text, inputs, textareas, the Composer, Notes, Monaco source, and Terminal selection use the same App controller; Browser-page selection remains inside the Browser runtime boundary.

`textAction()` declares a label, order, a same-plugin UI-exposed command operation, and optional `when` constraints for source, origin, editability, and Unicode character bounds. The host evaluates those constraints against the frozen snapshot and invokes the operation with `{ selection }`.

Actions are qualified by `pluginId + actionId`, so different plugins may use the same local ID or label without replacing each other. Native edit commands appear first; plugin actions follow in stable plugin groups ordered by group order, plugin name, action order, and local ID. Reload, disable, and uninstall remove only the owning plugin's actions.

Without `presentation`, a text action is a command and closes after execution. With `presentation: { kind: "popover", component, width }`, the host replaces the menu with loading state and then mounts the trusted result component beside the selection. `PluginTextActionSurfaceContext` supplies the invocation ID, frozen selection, validated operation output, and `close()`. The host owns anchoring, viewport collision, one-surface-at-a-time behavior, focus restoration, Escape/outside-click handling, retry/error controls, cancellation, ARIA, and the narrow-screen bottom sheet. The plugin owns only result content; one failed operation or renderer does not affect other registered actions.

## Message Slots

`messageSlot()` adds a lazy trusted component at `message.before`, `message.after`, or `message.actions`, optionally filtered to user or assistant roles. `PluginMessageSurfaceContext` contains only message ID and role; a plugin with `session.read` queries any required content through its own operation. Slots cannot replace the native message renderer.

`messageRenderer()` may render a declared custom message type. For a plugin-owned Tool card, set `messageType: "tool"` and `tool` to the exact generated host tool name:

```ts
messageRenderer({
  id: "correction-card",
  label: "Correction",
  messageType: "tool",
  tool: "plugin__language-coach__record-correction",
  component: { source: "./src/ui/correction-card.tsx" },
})
```

The plugin must contribute that Tool itself; a renderer cannot replace another plugin's or a built-in Tool. The component receives `PluginToolMessageSurfaceContext`, which adds assistant message identity and the bounded Tool `name`, `input`, `metadata`, `title`, `output`, and `status`. It should render useful input/output even when a later query or event subscription is unavailable. Each plugin Tool card owns its own error boundary: a throwing renderer falls back to the normal host Tool card without replacing healthy sibling cards.

## Resource Tabs

`openWorkbenchPanel(panelId, resource)` preserves the opaque resource `id`, `title`, and JSON `state`. The host reuses an existing tab for the same `panelId + resource.id` and opens a separate tab for a different resource. The component reads the exact resource from `context.surface.resource`; it must not infer resource identity from a global variable or private route.

This supports one contribution with multiple stable views, such as a map, one tab per entity, and a diagnostics page. `defaultResource` is used when the workbench opens the panel without an explicit resource.

## Declarative Settings

Object-form settings are rendered with the host's design system. Boolean fields use `SettingRow` and `Switch`; strings, numbers, and enums use host form controls and semantic tokens. The schema's top-level description is shown as page help. Saves are optimistic and roll back with a host notification if persistence fails. A plugin component should not reproduce the settings page chrome or form layout.

A custom `ui.settings` component receives `PluginSettingsComponentProps`: the existing `pluginId`, `values`, and `onChange` props plus `context: PluginSettingsSurfaceContext`. The context is the same capability-bound surface contract used by other trusted UI, so Settings can call UI-exposed query/command operations and host confirmation or notification actions without learning the Synergy server URL or token. The host continues passing the legacy props so previously built settings components remain compatible.

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

The template includes `themes/theme.schema.json`. Theme tooling may import `ThemeSchema`, `parseTheme()`, `resolveTheme()`, and the token catalog from `@ericsanchezok/synergy-plugin/theme`. Plugin Kit `build`, `validate`, and `dev` validate both source and packaged Theme JSON with that public parser. Missing or escaping paths, malformed JSON, ID mismatches, and resolver failures stop the command with a nonzero result. Theme and icon content hashes are part of the generation, so declarative-only edits receive new asset URLs; dev keeps its last valid generation when validation fails.

The host namespaces theme and icon IDs as `<plugin-id>:<contribution-id>`. Surface `icon` fields continue to use the plugin-local contribution ID; the host resolves it to the namespaced registered icon. Assets are fetched and validated before an atomic reload replaces the previous generation.

## Scope and Reload

The Web host fetches contributions for the active Scope. Switching Scope rebuilds registrations with a new context. Runtime generations and asset URLs include the generation so stale bundles are not reused. The host resolves trusted UI bundles, themes, and icons against the active Synergy server URL, preserving remote origins and deployment path prefixes such as reverse-proxy mounts. A failure in one surface is reported for that contribution and does not remove unrelated plugin contributions.

Registration lifecycle changes are observable to already-mounted message resolvers. Unregistering a renderer, installing or replacing its loader, and completing the current lazy load each invalidate the registry. A Tool card that briefly falls back during reload therefore retries resolution and restores its custom renderer without a page refresh; completion from a stale loader remains ignored.
