# Plugin UI Contributions

UI API 5 supports host-rendered declarations and approved Solid components. Backend Plugin API 4 and runtime IPC 9 are independent versions. An executable UI artifact must declare `artifacts.ui.apiVersion: "5.0"`; missing versions identify UI 4 and are rejected before module evaluation. Incompatible UI does not disable the plugin's backend tools, operations, or declarative settings. See the [UI 4 migration](../migrations/plugin-ui-4-to-5.md).

## Components and services

Every component receives exactly `PluginComponentProps<Context>`: one `context` property. This includes settings, tool cards, text-action results, headless extensions, resource panels, pages, and Shells. Specialization adds typed services inside that context. The [public types](../../packages/plugin/src/ui.ts) are authoritative; generated operation and event types do not require importing the App or Core.

```tsx
import type { PluginComponentProps, PluginWorkbenchSurfaceContext } from "@ericsanchezok/synergy-plugin"
import { Button, SettingRow } from "@ericsanchezok/synergy-plugin/components"

export default function Panel({ context }: PluginComponentProps<PluginWorkbenchSurfaceContext>) {
  return (
    <SettingRow
      title={context.tab().title ?? "Resource"}
      description="Plugin resource"
      trailing={<Button onClick={() => context.workbench.update(context.tab().id, { dirty: false })}>Save</Button>}
    />
  )
}
```

| Service                | Responsibility                                                                                            |
| ---------------------- | --------------------------------------------------------------------------------------------------------- |
| `environment`          | Reactive route, Scope key, platform, locale, theme/mode, visibility and viewport                          |
| `navigation`           | Typed destinations and history replacement                                                                |
| `sessions`             | Existing Scope session collection, readiness and explicit refresh                                         |
| `operations`, `events` | Same-plugin queries, commands and declared scoped event payloads                                          |
| `settings`             | Scoped settings snapshots, writes and subscriptions                                                       |
| `workbench`            | Panel discovery, resource tabs, activation, ordering, title/state/dirty updates and negotiated close      |
| `resources`            | Open a file or artifact through the mounted host resource presenter; an unavailable presenter is an error |
| `commands`             | Owned commands, host command execution and menu registrations                                             |
| `extensions`           | Finite extension metadata and actual outlet rendering                                                     |
| `overlays`             | Owned dialogs, protected confirmations and notifications                                                  |
| `lifetime`             | Abort signal and idempotent `onDispose()` registrations                                                   |

Services enforce approved capabilities. Shell layout authority does not grant session mutation, draft writes, command registration, or resource access. Navigation, resource presentation and ordinary overlays require `ui.hostActions`; workbench reads/writes use `workbench.read`/`workbench.write`; session reads, submission and control remain separate capabilities. Operations also enforce their declared UI exposure and backend requirements.

A mounted surface has one plugin generation, server, Scope, optional Session, contribution and resource identity. Leaving that identity aborts UI requests, revokes callbacks and releases subscriptions, command registrations, portals and owned DOM references. An already accepted server task continues under its domain owner. Do not retain a context for use after its lifetime ends.

`synergy-plugin typegen` writes declarations under `src/generated/plugin-data/` from operation/event schemas. Import the generated `PluginDataContext` to infer valid IDs, inputs, outputs and event payloads. Queries return complete state; events carry scoped invalidations or small state changes. The host uses its existing event connection. It does not create a plugin event connection per component or refetch every component on each event.

## Public components

Import `Button`, `Input`, `Select`, `Tabs`, `Menu`, `Dialog`, `Popover`, `Tooltip`, `FormField`, `SettingRow`, `EmptyState`, `ErrorState`, `Loading`, `Icon` and `HostView` from `@ericsanchezok/synergy-plugin/components`. These resolve to the host's UI implementation and shared Solid runtime. Semantic icons are typed by `@ericsanchezok/synergy-plugin/icons`; locale-sensitive number/date/relative-time/byte formatting is available from `@ericsanchezok/synergy-plugin/format`.

`FormField` supplies the control's ID, description and error relationships to its child function. `Popover.trigger` is a button component receiving trigger attributes, for example `trigger={props => <Button {...props}>Options</Button>}`. This preserves one accessible button and keyboard/focus behavior. Public dialogs, nested menus and popovers inherit the owning plugin's style and overlay layers; authors do not query host dialog DOM or select a global portal target.

Create dialogs with `context.overlays.dialog(handle => <Dialog title="Preferences">…</Dialog>)`. Close that handle to close that dialog. `context.overlays.confirm()` uses the protected host decision surface. Disposing one plugin cannot close another plugin's dialog.

## Shells and session presentation

`shell()` declares a root component and optional page mapping. The finite page and extension catalogs live in [ui-catalog.ts](../../packages/plugin/src/ui-catalog.ts). Users select one Shell per server in Settings → General; installation alone does not activate it. An unavailable selection remains saved while the default Shell renders. A failing Shell falls back to the default presentation and is suppressed until explicitly retried or replaced.

`PluginShellContext` adds `shell`, and session pages provide `session`, `conversation`, `composerLayout`, `input` and `layout`. Default Shell, conversation, composer layout and editor presentations consume these public services. Domain providers retain the draft, session windows, submission, workflow, workbench and browser owners outside replaceable presentation.

- `shell.render()` and `HostView` compose native navigation, route, footer, conversation, composer, side workbench and bottom workbench views. A view unsupported on that page throws explicitly.
- `session` reads the existing bounded message/part window, status and history state and delegates history loading, return-to-latest, refresh, rewind and fork to the session owner.
- `conversation` supplies the shared turn projection, bounded render window, history controls, viewport bindings and canonical message actions. Replacing its view does not create another message store or derive message semantics.
- `input` supplies revisioned text and selection, IME state, attachments, agent/model/variant choices and explicit submit/stop. Its optional native editor mounting API uses the same document as headless edits. Native workflow controls can be composed through the service's named control views.
- `composerLayout` supplies layout state, navigation links and host-owned inbox, delegation, greeting, status, priority and decision views. It does not expose the SDK or synchronization store.

Draft edits reject stale revisions, read-only state, overlapping ranges and file-pill crossings. Model selection retains explicit draft → session default → fallback resolution. Preflight work and late upload/submission results retain the captured draft identity; failed submission cannot overwrite subsequent user edits. IME prevents settlement/submission until composition ends. Detaching the presentation releases editor and scroll bindings without disposing domain state.

Authentication, installation grants, runtime permission decisions, connection recovery and Browser ownership remain host-controlled. Desktop Browser uses native presentation; Web uses the existing WebRTC presentation. Shell replacement cannot allocate another page for a Session.

## Extensions, commands and resources

The public extension catalog specifies context, cardinality, ordering, focus, overflow, collision handling and platform availability. Use `context.extensions.render()` for custom layouts. `app.footer` is required; omitting it invalidates a custom Shell. Optional outlets may be absent, but diagnostics distinguish registered contributions from contributions whose current workbench has no outlet.

`slot()`, `composerAction()`, `messageSlot()`, `navigationItem()`, `workbenchPanel()` and custom settings use the same component mounting lifecycle. Conditions are finite typed expressions over host facts. IDs are namespaced by plugin before registration, so two plugins can use the same local contribution ID. UI commands can call declared operations; menus refer to existing command IDs and approved locations. Asynchronous failures reach the host's error presentation rather than becoming unhandled rejections.

Use qualified panel IDs, such as ``context.workbench.open(`${context.pluginId}:notes`, { id: "first", title: "First note" })``. Same-panel/same-resource opens reuse a tab; distinct resources retain independent state. `context.tab()` on a workbench component reads its current tab. Update title, state and `dirty` through `workbench.update()`, and register `beforeClose()` for asynchronous close negotiation. Explicit close, close-other and exclusive replacement share the owner's close policy. Refresh restores the existing versioned workbench layout; absent plugins produce an unavailable panel rather than rewriting plugin business data.

## Composer and selected-text extensions

`composerExtension()` mounts headless logic for the active Composer. `composer.read` permits immutable revision/text/selection snapshots and the 700 ms settled hook; `composer.write` permits completions, decorations and revision-checked edits; `composer.intercept` permits serial normal-message preflight. Completion requires a collapsed caret. Draft callbacks run in parallel after IME settles; preflight callbacks run in contribution order and read preceding edits. Shell commands and workflow starts do not enter normal-message preflight.

`selectionExtension()` receives settled immutable text after 250 ms, with a selection ID, source, origin and editable/container flags. Passwords, credentials, excluded nodes and oversized selections are excluded. Browser-page selection stays with Browser ownership.

`textAction()` refers to a same-plugin UI-exposed command operation and finite selection conditions. The command receives `{ selection }`. A result presentation receives `PluginTextActionSurfaceContext`: invocation ID, frozen selection, validated output and `close()`. The host owns collision handling, loading/error/retry, cancellation, Escape, focus return and the narrow-screen presentation. Plugin actions remain distinct from native edit commands.

## Message renderers and settings

`messageSlot()` adds content before, after or alongside message actions. A tool renderer must set `messageType: "tool"` and the exact owned Tool ID from `PluginToolId.format(pluginId, toolId)`. It cannot replace a host Tool or another plugin's Tool. `PluginToolMessageSurfaceContext` includes message identity and bounded tool name/input/output/metadata/status. Renderer failure falls back to the host card without removing healthy siblings.

Schema settings use native controls. A custom settings component receives only `context: PluginSettingsSurfaceContext`; `context.settings.values()`, `change()` and `status()` participate in the host form's save state. Scoped `get()`, `replace()` and `subscribe()` remain available for independent settings dialogs. There are no sibling `pluginId`, `values` or `onChange` props.

## Themes, Skins and styles

Themes own semantic colors through [the canonical theme parser](../reference/frontend-theming.md). Skins own fonts, backgrounds, textures, material radii/borders/shadows, density and decorative imagery. `skin()` references validated structured JSON with explicit packaged assets, light/dark appearances, narrow overrides and reduced-motion behavior. Theme references select a theme without embedding a component palette. Explicit user font choices take priority over Skin fonts.

Skin material targets are finite public `data-ui-part` values. Decorative layers cannot intercept input. Protected host surfaces stay outside the Skin root. Skin and Shell selection are independent and saved per server. A selected Skin whose plugin is unavailable falls back without erasing that selection.

Plugin Kit parses imported CSS as an AST. It scopes selectors to the plugin's mount and owned portals, namespaces keyframes/font families/layers, rewrites local asset references and rejects global/remote style escape paths. Stylesheets and all emitted image/font/module assets are listed and hashed in the artifact manifest. The host loads that explicit graph; it does not probe a neighboring stylesheet or rely on authors remembering selector prefixes. Trusted JavaScript still runs in the App's context after approval: CSS isolation is not a JavaScript sandbox.

The host validates an entire candidate generation before replacement and retains the last valid generation if validation fails. The existing `plugin.ui.updated` stream event drives UI refresh. Stale loaders and callbacks cannot install into a replacement generation. Native module loading uses integrity-checked preload and shared module URLs; repeated surfaces share evaluation. Disposing a generation clears its registrations and loader references; it does not claim to unload the browser's ESM cache.

Themes aggregate across enabled Scopes through the global theme registrar; icons and executable UI remain Scope-bound. Asset URLs preserve the configured server origin and proxy path prefix. Switching servers invalidates the previous generation and its pending requests.

## Authoring, preview and recovery

`synergy-plugin preview` builds the plugin and starts an isolated real Synergy server with its own home and loopback port. The command uses the production App, normal plugin approval, production loaders and registries. It watches actual runtime/UI dependencies and declared resources, including dependencies outside the project. Invalid builds retain the last valid artifact. Capability changes require restarting preview and reviewing the new grant. Closing preview aborts and settles pending generation work before releasing its own runtime and home.

The public `@ericsanchezok/synergy-plugin-kit/testing` entry exports isolated preview startup, explicit fixture approval and caller-owned browser-page helpers. The [packed template suite](../../test/plugin-ui5/templates-browser.test.ts), [functional sample](../../packages/plugin-kit/test/fixtures/ui5-functional/src/index.ts) and [workbench/Skin sample](../../packages/plugin-kit/test/fixtures/ui5-workbench/README.md) exercise the production host. Run `bun run plugin-ui:test` after building the App.

Start with `?safe-ui=1` to skip executable third-party UI and Skins before loading them. Recovery stays active in that browser tab across routing and reloads. Settings → General → Restart normally explicitly clears it. This path does not depend on a third-party Shell rendering successfully; a synchronous plugin loop still requires reloading into recovery.
