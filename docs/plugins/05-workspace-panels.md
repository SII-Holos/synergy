# Workspace and Global Panels

- **Audience:** Plugin developers
- **Prerequisites:** [Plugin manifest structure](./02-manifest.md), [UI contributions](./04-ui-contributions.md)

## What panels are

Panels are full-screen or sidebar surfaces that plugins contribute to the Synergy Web client. There are two kinds:

- **Workspace panels** appear as tabs in the right-side workspace drawer, alongside built-in panels like the diff viewer and terminal. The workspace drawer is a resizable sidebar on session pages.
- **Global panels** are full-overlay panels that replace the main content area. Built-in examples: Library, Agenda, Lucid.

Panels can be **Tier 2 (trusted)** or **Tier 3 (sandbox)** depending on the plugin's trust tier:

| Tier             | How it renders                                             | Required permission      |
| ---------------- | ---------------------------------------------------------- | ------------------------ |
| Tier 2 (trusted) | Dynamic import of a Solid.js component into the host page  | `ui.trustedImport: true` |
| Tier 3 (sandbox) | `<iframe sandbox="allow-scripts">` with postMessage bridge | `ui.sandboxIframe: true` |

## Declaring panels in the manifest

Panels are declared under `contributes.ui`:

```jsonc
// plugin.json
{
  "contributes": {
    "ui": {
      "workspacePanels": [
        {
          "id": "dashboard",
          "label": "Dashboard",
          "icon": "bar-chart-3",
          "exportName": "DashboardPanel",
        },
      ],
      "globalPanels": [
        {
          "id": "analytics",
          "label": "Analytics",
          "icon": "trending-up",
          "sandbox": true,
          "sandboxEntry": "analytics.js",
        },
      ],
    },
  },
}
```

### Panel definition fields

| Field          | Type                  | Required | Default                     | Description                                                                                                                  |
| -------------- | --------------------- | -------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `id`           | `string` (1-64 chars) | yes      | —                           | Unique panel identifier within the plugin. Prefixed with `${pluginId}:` at registration.                                     |
| `label`        | `string` (1-64 chars) | yes      | —                           | Human-readable tab/button label.                                                                                             |
| `icon`         | `string`              | yes      | —                           | Lucide icon name (e.g. `"bar-chart-3"`, `"book-open"`).                                                                      |
| `exportName`   | `string`              | no       | `"default"`                 | Named export from the UI entry bundle. Only used for Tier 2 (trusted) plugins.                                               |
| `sandbox`      | `boolean`             | no       | `false`                     | When `true`, renders in a sandboxed iframe via the postMessage bridge.                                                       |
| `sandboxEntry` | `string`              | no       | `ui.entry` / `"dist/ui.js"` | Entry script for the sandbox iframe HTML shell. Pattern: alphanumeric, underscores, slashes, dots, hyphens, ending in `.js`. |

### Required permissions

```jsonc
{
  "permissions": {
    "ui": {
      "workspacePanels": true, // required for workspace panels
      "globalPanels": true, // required for global panels
      "trustedImport": true, // required for Tier 2
      "sandboxIframe": true, // required for Tier 3
    },
    "network": {
      "frameDomains": ["https://api.example.com"], // if sandbox panel loads external resources
    },
  },
}
```

## Panel component props

Every panel component receives a `PluginPanelProps` object, defined in `packages/plugin/src/ui.ts`:

```ts
interface PluginPanelProps {
  pluginId: string
  panelId: string
  scope?: { type: "global" | "project"; id: string; directory: string }
  sessionId?: string
}
```

- `pluginId` — the plugin that owns this panel
- `panelId` — the full registered ID (`${pluginId}:${panelId}`)
- `scope` — current scope context, present when the panel is rendered in a project session
- `sessionId` — current active session, present when the panel is rendered alongside a session

## Tier 2: Trusted import

A Tier 2 panel is a Solid.js component exported from the plugin's UI entry bundle. The host imports it dynamically via `loadPluginExport()` and renders it with `<Dynamic component={...} />`.

### Plugin code

Create a Solid.js component in your UI entry file:

```tsx
// ui/index.tsx
import { type Component, createSignal } from "solid-js"
import type { PluginPanelProps } from "@ericsanchezok/synergy-plugin"

const DashboardPanel: Component<PluginPanelProps> = (props) => {
  const [count, setCount] = createSignal(0)

  return (
    <div style={{ padding: "1rem" }}>
      <h2>Dashboard ({props.panelId})</h2>
      <p>Plugin: {props.pluginId}</p>
      <p>Scope: {props.scope?.type ?? "none"}</p>
      <p>Session: {props.sessionId ?? "none"}</p>
      <button onClick={() => setCount((c) => c + 1)}>Clicked {count()} times</button>
    </div>
  )
}

export default DashboardPanel
```

### Manifest entry

```jsonc
{
  "contributes": {
    "ui": {
      "entry": "dist/ui.js",
      "workspacePanels": [
        {
          "id": "dashboard",
          "label": "Dashboard",
          "icon": "bar-chart-3",
          "exportName": "default",
        },
      ],
    },
  },
  "permissions": {
    "ui": {
      "workspacePanels": true,
      "trustedImport": true,
    },
  },
}
```

### How the host loads it

At activation, the host calls `loadPluginExport(contribution, "default")` which performs a dynamic `import(/* @vite-ignore */ url)` of the plugin's UI bundle from `/plugin/assets/:pluginId/:version/:entry`. The returned component is cached and rendered via Solid's `<Dynamic>` component. Errors during import show a "Plugin panel unavailable" fallback.

## Tier 3: Sandbox iframe

A Tier 3 panel runs in a sandboxed `<iframe sandbox="allow-scripts">` (no `allow-same-origin`). The host communicates with the panel through `window.postMessage`. The server serves an HTML shell that loads the panel's entry script.

### How it works

1. The host renders `<SandboxShell>` with `src="/plugin/:pluginId/sandbox/:panelId"`
2. The server responds with an HTML page that loads the panel's entry script
3. The panel script sends a `plugin.ready` message once initialized
4. The host hides the loading spinner when `plugin.ready` is received
5. All further communication uses the typed bridge protocol through `window.parent.postMessage`

### Plugin code

Create a standalone JavaScript file that runs in the iframe. It does not use Solid.js — it runs as a plain script in the sandbox context:

```js
// analytics.js — runs inside the sandbox iframe
;(function () {
  const hostOrigin = window.location.origin

  function post(msg) {
    window.parent.postMessage(msg, hostOrigin)
  }

  // Signal that the panel is ready
  post({ type: "plugin.ready" })

  // Listen for messages from the host
  window.addEventListener("message", (event) => {
    if (event.origin !== hostOrigin) return
    const msg = event.data

    switch (msg.type) {
      case "plugin.init":
        renderDashboard(msg.payload)
        break
      case "host.action":
        handleHostAction(msg)
        break
    }
  })

  function renderDashboard(config) {
    document.body.innerHTML = `
      <div id="root">
        <h2>Analytics Dashboard</h2>
        <div id="chart">Loading...</div>
      </div>
    `
  }

  function handleHostAction(msg) {
    post({ type: "plugin.action", id: "ack", payload: { received: msg.id } })
  }
})()
```

### Manifest entry

```jsonc
{
  "contributes": {
    "ui": {
      "entry": "dist/ui.js",
      "globalPanels": [
        {
          "id": "analytics",
          "label": "Analytics",
          "icon": "trending-up",
          "sandbox": true,
          "sandboxEntry": "analytics.js",
        },
      ],
    },
  },
  "permissions": {
    "ui": {
      "globalPanels": true,
      "sandboxIframe": true,
    },
  },
}
```

### Sandbox entry resolution

The server resolves the entry script for a sandbox panel in this priority:

1. `panel.sandboxEntry` — per-panel override
2. `ui.entry` — the UI bundle entry for the whole plugin
3. `"dist/ui.js"` — fallback default

The resolved path is served from the plugin's asset directory at `/plugin/assets/:pluginId/:version/:entry`.

## PostMessage bridge protocol

The bridge protocol is defined in `packages/app/src/plugin/sandbox/postmessage-bridge.ts` and supports these message types:

### Plugin → Host messages

| Type            | Payload                                              | When                                            |
| --------------- | ---------------------------------------------------- | ----------------------------------------------- |
| `plugin.ready`  | none                                                 | Panel initialized and ready to receive messages |
| `plugin.init`   | `{ config: Record<string, unknown>, theme: string }` | Host delivers initial config and theme          |
| `plugin.action` | `{ id: string, payload: unknown }`                   | Plugin sends an action or data to the host      |
| `plugin.resize` | `{ width: number, height: number }`                  | Plugin requests a resize of its iframe          |
| `plugin.toast`  | `{ message: string, variant?: string }`              | Plugin requests showing a toast notification    |
| `plugin.error`  | `{ message: string, code?: string }`                 | Plugin reports an error to the host             |

### Host → Plugin messages

| Type          | Payload                                              | When                                                             |
| ------------- | ---------------------------------------------------- | ---------------------------------------------------------------- |
| `host.action` | `{ id: string, payload: unknown }`                   | Host sends an action or data to the plugin                       |
| `plugin.init` | `{ config: Record<string, unknown>, theme: string }` | Host initializes the panel with config and theme on first render |

### Origin validation

The `SandboxShell` validates message origins:

- Messages from the same origin (`window.location.origin`)
- Messages from opaque origins (`"null"` — the sandbox iframe's origin, since it has no `allow-same-origin`)

Messages from any other origin are silently dropped.

### Relaying to the server

Plugins can send actions to the server via `POST /plugin/:pluginId/interact`:

```json
{
  "type": "plugin.action",
  "payload": { ... },
  "source": "panel:analytics"
}
```

This endpoint is a lightweight relay — the plugin's runtime handlers can listen on the `event` hook for downstream processing.

## Skeleton → mount lifecycle

Both workspace and global panels follow the same loading pattern:

1. **Registration** — The panel is registered in the appropriate registry during plugin lifecycle activation. Workspace panels are registered in `WorkspacePanelEntry` via `registerWorkspacePanel()`. Global panels are registered in `GlobalPanelEntry` via `registerGlobalPanel()`.

2. **User interaction** — The user clicks a tab (workspace) or navigates to a route (global).

3. **Lazy resolution** — The host determines the panel type:
   - **Pre-registered Solid component** (`entry.component`): rendered immediately via `<Dynamic>`
   - **Sandbox iframe** (`entry.sandbox === true`): rendered via `<SandboxShell>`
   - **Lazy import** (`entry.pluginId` + `entry.exportName`): the host calls `loadPluginExport()` to dynamically import the component via `import(/* @vite-ignore */ url)` where `url = /plugin/assets/:pluginId/:version/:entry`

4. **Loading state** — While loading (for lazy imports), a centered spinner is shown:

   ```
   <div class="flex items-center justify-center h-full">
     <Spinner class="size-5" />
   </div>
   ```

   For sandbox panels, the shell shows a "Loading sandbox..." message until the iframe sends `plugin.ready`.

5. **Error state** — If the import fails, the panel shows "Plugin panel unavailable". Sandbox errors are wrapped in an `<ErrorBoundary>` and displayed inline with the error message.

6. **Hide/show** — The panel component survives hide/show differently by panel type:
   - **Workspace panels**: the drawer collapses to `width: 0px` with a CSS transition. The DOM and component state persist during the closing animation. When the drawer re-opens, the same component instance is reused.
   - **Global panels**: the overlay is conditionally rendered via `<Show>`. The panel component remounts each time the global panel is opened.

## Complete example: Dashboard panel with server-side data

This example shows a Tier 2 workspace panel that fetches data from a server-side tool.

### Server-side plugin (`src/index.ts`)

```ts
import type { Plugin } from "@ericsanchezok/synergy-plugin"
import { tool } from "@ericsanchezok/synergy-plugin/tool"

const DashboardPlugin: Plugin = async (ctx) => {
  return {
    tool: {
      workspace_metrics: tool({
        description: "Return workspace metrics for the dashboard panel",
        args: {
          scope: tool.schema.string().describe("Scope ID to query metrics for"),
        },
        async execute(args) {
          const fileCount = await ctx.$`find . -type f | wc -l`.cwd(ctx.worktree).quiet().text()
          const branch = await ctx.$`git rev-parse --abbrev-ref HEAD`.cwd(ctx.worktree).quiet().text()

          return JSON.stringify({
            files: parseInt(fileCount.trim(), 10),
            branch: branch.trim(),
            scope: args.scope,
          })
        },
      }),
    },
  }
}

export default DashboardPlugin
```

### UI entry (`ui/index.tsx`)

```tsx
import { type Component, createSignal, createResource } from "solid-js"
import type { PluginPanelProps } from "@ericsanchezok/synergy-plugin"

interface Metrics {
  files: number
  branch: string
  scope: string
}

const DashboardPanel: Component<PluginPanelProps> = (props) => {
  const [refresh, setRefresh] = createSignal(0)
  const [metrics] = createResource(refresh, async () => {
    // Fetch metrics.json served by the plugin's static assets
    const response = await fetch(`/plugin/assets/${props.pluginId}/metrics.json`)
    if (!response.ok) throw new Error("Failed to load metrics")
    return (await response.json()) as Metrics
  })

  return (
    <div style={{ padding: "1.5rem", "font-family": "system-ui" }}>
      <div
        style={{
          display: "flex",
          "align-items": "center",
          "justify-content": "space-between",
          "margin-bottom": "1.5rem",
        }}
      >
        <h2 style={{ margin: 0, "font-size": "1.25rem" }}>Workspace Dashboard</h2>
        <button
          onClick={() => setRefresh((r) => r + 1)}
          style={{ padding: "0.375rem 0.75rem", "font-size": "0.8125rem", cursor: "pointer" }}
        >
          Refresh
        </button>
      </div>

      <div style={{ display: "grid", "grid-template-columns": "1fr 1fr", gap: "1rem" }}>
        <MetricCard label="Files" value={metrics()?.files.toLocaleString() ?? "\u2014"} color="#3b82f6" />
        <MetricCard label="Branch" value={metrics()?.branch ?? "\u2014"} color="#10b981" />
      </div>
    </div>
  )
}

const MetricCard: Component<{ label: string; value: string; color: string }> = (props) => (
  <div
    style={{
      padding: "1rem",
      "border-radius": "0.5rem",
      background: "var(--surface-raised-base, #f8fafc)",
      border: `1px solid ${props.color}33`,
    }}
  >
    <div style={{ "font-size": "0.75rem", color: "var(--text-weak, #64748b)", "margin-bottom": "0.25rem" }}>
      {props.label}
    </div>
    <div style={{ "font-size": "1.25rem", "font-weight": 600, color: props.color }}>{props.value}</div>
  </div>
)

export default DashboardPanel
```

### Manifest (`plugin.json`)

```jsonc
{
  "name": "dashboard-plugin",
  "version": "0.1.0",
  "description": "Workspace dashboard panel with metrics",
  "main": "./src/index.ts",
  "contributes": {
    "ui": {
      "entry": "dist/ui.js",
      "workspacePanels": [
        {
          "id": "dashboard",
          "label": "Dashboard",
          "icon": "bar-chart-3",
          "exportName": "default",
        },
      ],
    },
  },
  "permissions": {
    "ui": {
      "workspacePanels": true,
      "trustedImport": true,
    },
  },
}
```

## Built-in panels reference

The client registers these global panels at startup (see `packages/app/src/plugin/registries/panel-registry.ts`):

| ID       | Label   | Icon             |
| -------- | ------- | ---------------- |
| `engram` | Library | `book-open`      |
| `agenda` | Agenda  | `clipboard-list` |
| `lucid`  | Lucid   | `sparkles`       |

These IDs are reserved and cannot be overridden by plugins. Plugin panels are always prefixed with `${pluginId}:` to avoid collisions.

## Key implementation files

| File                                                       | Purpose                                                                                       |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `packages/app/src/components/session/workspace-drawer.tsx` | Workspace drawer rendering with `PluginWorkspaceContent` for lazy/sandbox resolution          |
| `packages/app/src/pages/layout.tsx`                        | `GlobalPanelSwitch` and `PluginGlobalPanelContent` for global panels                          |
| `packages/app/src/plugin/registries/workspace-registry.ts` | `WorkspacePanelEntry` type and `registerWorkspacePanel()`                                     |
| `packages/app/src/plugin/registries/panel-registry.ts`     | `GlobalPanelEntry` type, `registerGlobalPanel()`, and built-in panel definitions              |
| `packages/app/src/plugin/lifecycle.ts`                     | Plugin activation that reads `ui.workspacePanels` / `ui.globalPanels` and wires registrations |
| `packages/app/src/plugin/loaders.ts`                       | `loadPluginExport()` for dynamic import of Tier 2 components                                  |
| `packages/app/src/plugin/sandbox/sandbox-shell.tsx`        | `SandboxShell` iframe component with postMessage listener                                     |
| `packages/app/src/plugin/sandbox/postmessage-bridge.ts`    | Typed `BridgeMessage` union and `parseBridgeMessage()`                                        |
| `packages/synergy/src/server/plugin-routes.ts`             | Server routes for sandbox HTML shell, asset serving, and interaction relay                    |
| `packages/plugin/src/ui.ts`                                | `PluginPanelProps` and `PluginPanelComponent` types                                           |
| `packages/plugin/src/manifest.ts`                          | `PanelDef` Zod schema for panel manifest declarations                                         |
