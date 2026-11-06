# Plugin UI 4 to UI 5

This guide migrates executable frontend components. Backend Plugin API 4 and IPC 9 do not change. Existing backend capabilities and compatible declarative themes/icons remain available when executable UI4 is rejected.

## Rebuild the artifact

Upgrade the Plugin and Plugin Kit packages, then rebuild. UI5 output requires a compatible Synergy host and declares `artifacts.ui.apiVersion: "5.0"`, the UI entry/hash and every packaged UI resource/hash. Do not edit the generated manifest to claim a version: compilation, export validation, CSS transformation and the complete resource graph are required. Missing UI versions identify UI4.

## Move every component to one context

Use `PluginComponentProps<SpecializedContext>`. Remove flat context props and any component that accepts both flat and wrapped variants. For custom settings, replace sibling `values`/`onChange` with `context.settings.values()`/`change()`; read save status with `context.settings.status()`.

Replace the UI4 `context.host` facade with the owning service:

| UI4 call                                     | UI5 service                                                             |
| -------------------------------------------- | ----------------------------------------------------------------------- |
| `host.openSession(id)`                       | `navigation.open({ page: "session", sessionId: id })`                   |
| `host.openPluginPage(path)`                  | `navigation.open({ page: "plugin-page", pluginId, navigationId })`      |
| `host.openWorkbenchPanel(localId, resource)` | `workbench.open(qualifiedPanelId, resource)`; await or handle rejection |
| `host.openResource(resource)`                | `resources.open(resource)`                                              |
| `host.notify()` / `host.confirm()`           | `overlays.notify()` / `overlays.confirm()`                              |

Declare the capabilities for the services actually used, including separate workbench reads/writes, session reads/submission/control and composer reads/writes. Shell presentation authority alone does not grant them. Replace a boolean session-presence prop with `context.sessionId` or the reactive environment route.

## Adopt owned UI and data

Import components from `@ericsanchezok/synergy-plugin/components`. Create dialogs through `overlays.dialog()` and close the returned handle. Remove global portal lookup, private App imports and dialog DOM selectors. A Popover trigger is a button component that forwards the provided attributes; FormField's child receives the control's accessibility attributes.

Generate `PluginDataContext` with `synergy-plugin typegen`. Keep operation/event schemas authoritative. Register subscriptions, menu/command entries and other cleanup through the surface lifetime. Do not use callbacks after an identity switch or retain a UI request as the owner of a server task.

## Migrate styles and composition

Remove manually injected stylesheets, neighboring-CSS probes and author-side global CSS prefixes. Import local CSS and assets from source so Plugin Kit validates, scopes, rewrites and hashes them. Replace root/body selectors and external style URLs with component-local selectors and packaged resources. Put semantic colors in structured Themes and fonts/materials/textures in structured Skins.

A custom Shell uses the public page and extension catalogs and renders the required `app.footer`. Use public input/session/conversation/workbench services or native HostViews; do not duplicate stores, submission, event transport, Browser page ownership or persisted draft/layout state. Optional outlets that are absent remain visible in host diagnostics as unavailable on that workbench.

## Validate the installed result

Build, typecheck and pack; test the archive through `synergy-plugin preview` or the public Plugin Kit testing helpers. Verify settings inside nested overlays, same/different resource tabs, navigation during pending requests, reload/disable cleanup, and light/dark/narrow layouts. A capability change requires a fresh approval review. Use `?safe-ui=1` if an old or faulty Shell prevents normal interaction, and use Restart normally after selecting a working Shell.

Current APIs and examples live in [UI contributions](../plugins/ui-contributions.md).
