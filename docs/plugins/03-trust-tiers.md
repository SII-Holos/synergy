# Trust Tiers & Permissions

This document explains how Synergy determines plugin trust levels, the three-tier isolation model, and the permissions system that governs what plugins can do.

## Overview

Synergy uses a **trust-based isolation model** to run plugins at different privilege levels. Each plugin is assigned a trust tier based on where it comes from. The tier determines how the plugin's code is loaded and what capabilities it can access by default.

| Tier | Name                | Execution Model                         | Default Sources                                |
| ---- | ------------------- | --------------------------------------- | ---------------------------------------------- |
| 1    | Declarative Native  | JSON manifest only, no code execution   | Any plugin with only declarative contributions |
| 2    | Trusted Host Import | Same-origin dynamic import (`import()`) | `file://` local paths                          |
| 3    | Sandboxed Iframe    | Isolated iframe + postMessage bridge    | `npm:`, `github:`, `url:` specs                |

---

## Tier 1: Declarative Native

**No JavaScript execution.** All contributions come from the `plugin.json` manifest file.

Tier 1 is for plugins that only declare structured metadata:

- **Themes** — CSS variable definitions via `contributes.ui.themes`
- **Icons** — SVG icon registrations via `contributes.ui.icons`
- **Settings forms** — JSON schema for plugin configuration via `contributes.config.schema`
- **Tool card metadata** — fallback icon, title, and subtitle template for tool renderers via `contributes.ui.toolRenderers[].fallback`

### What Tier 1 can do

- Register declarative UI surfaces
- Contribute tools, skills, agents, MCP servers, and CLI commands via the manifest
- Participate in lifecycle hooks (server-side only, via the plugin's runtime `init()` function)

### What Tier 1 cannot do

- Execute JavaScript in the Web client
- Access the host SolidJS component tree
- Use dynamic imports or load modules in the browser

A plugin that has a `contributes.ui.entry` field or declares `sandbox: true` on any panel or settings section does **not** qualify as purely declarative — it escalates to Tier 2 or Tier 3 as appropriate.

---

## Tier 2: Trusted Host Import (trusted)

Tier 2 plugins are treated as **same-origin trusted code**. Their UI bundles are loaded via dynamic `import()` directly into the host SolidJS application.

### Loading mechanism

```
Host App → fetchContributions() → loadPluginBundle(contrib) → import(url)
```

In code, this is the `loadPluginBundle` function in `packages/app/src/plugin/loaders.ts`:

```ts
export async function loadPluginBundle(contribution: PluginContribution): Promise<PluginBundleExports> {
  if (contribution.trustTier !== "trusted") {
    throw new Error(`Cannot dynamic-import sandbox plugin ${contribution.pluginId}`)
  }
  const entry = contribution.ui.entry
  if (!entry) return {}
  const url = `/plugin/assets/${contribution.pluginId}/${contribution.version}/${entry}`
  return (await import(/* @vite-ignore */ url)) as PluginBundleExports
}
```

### What Tier 2 has access to

- **Full SolidJS context** — components, signals, routing, lifecycle
- **Synergy UI API** — `PluginUIContext`, tool renderers, part renderers, panels, settings sections, chat components, routes, commands
- **All declared permissions** — the plugin can access whatever its permissions field allows (data, network, tools)
- **Direct import of host modules** — same-origin means the JS bundle can reference the application's module graph

### Trust assignment

A plugin is assigned `trustTier: "trusted"` when its `pluginDir` resolves to a path **outside** the system cache directory (`~/.synergy/cache/`):

```ts
function determineTrustTier(pluginDir: string): "trusted" | "sandbox" {
  const cacheRoot = Global.Path.cache
  const relative = path.relative(cacheRoot, pluginDir)
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return "trusted"
  }
  return "sandbox"
}
```

**Default sources:** `file://` local plugin paths always resolve outside the cache, so local plugins are Tier 2 by default.

---

## Tier 3: Sandboxed Iframe (sandbox)

Tier 3 plugins run in an **isolated sandboxed iframe** with `sandbox="allow-scripts"`. They communicate with the host application through a typed `postMessage` bridge.

### Loading mechanism

1. Host renders a `<SandboxShell>` component with `src="/plugin/{pluginId}/sandbox/{panelId}"`
2. The server serves an HTML shell at that URL that loads the plugin's JS bundle
3. The iframe has `sandbox="allow-scripts"` — no `allow-same-origin`, so it gets an **opaque origin**
4. The plugin's JS sends a `"plugin.ready"` message over postMessage
5. The host validates the message origin (must be `"null"` for sandboxed iframes) and establishes communication

```tsx
<iframe
  ref={iframeRef}
  src={props.src}
  sandbox="allow-scripts"
  style={{ width: "100%", height: "100%", border: "none" }}
/>
```

### PostMessage bridge protocol

Validated message types (from `packages/app/src/plugin/sandbox/postmessage-bridge.ts`):

| Direction     | Type            | Purpose                                        |
| ------------- | --------------- | ---------------------------------------------- |
| Plugin → Host | `plugin.ready`  | Signal that the plugin has initialized         |
| Host → Plugin | `plugin.init`   | Pass config and theme to the plugin            |
| Plugin → Host | `plugin.action` | Send an action/event to the host               |
| Host → Plugin | `host.action`   | Relay an action to the plugin                  |
| Plugin → Host | `plugin.resize` | Request a size change for the iframe container |
| Plugin → Host | `plugin.toast`  | Show a notification toast                      |
| Plugin → Host | `plugin.error`  | Report an error                                |

### Security properties

| Property             | Behavior                                                                                  |
| -------------------- | ----------------------------------------------------------------------------------------- |
| Origin isolation     | Opaque origin (serialized as `"null"`) — the iframe cannot access the host origin         |
| Script execution     | Allowed (`allow-scripts`)                                                                 |
| Same-origin access   | **Denied** — no `allow-same-origin`, so cookies, localStorage, and DOM access are blocked |
| Top-level navigation | **Denied** — no `allow-top-navigation`                                                    |
| Forms                | **Denied** — no `allow-forms`                                                             |
| Popups               | **Denied** — no `allow-popups`                                                            |
| Host access          | Only through typed postMessage bridge messages                                            |

### What Tier 3 has access to

- The plugin's declared permissions (via the `plugin.init` bridge message payload)
- Sandboxed execution environment — limited to what the iframe sandbox allows
- Host services exposed through the bridge (e.g., showing toasts, requesting resize)

### What Tier 3 cannot do

- `allow-same-origin` is intentionally absent — the iframe cannot steal cookies or make authenticated fetch requests against the host
- Cannot directly invoke `import()` against host modules
- Cannot access the host's SolidJS component tree or signal graph
- Data access (session, workspace, config) is mediated through the bridge

### Default sources

`npm:`, `github:`, and other remote plugin specs are installed into `~/.synergy/cache/node_modules/`, which places them under the cache root. These plugins are assigned `trustTier: "sandbox"` by default.

---

## Default Tier Assignment

| Plugin Source           | Default Tier                  | Rationale                                |
| ----------------------- | ----------------------------- | ---------------------------------------- |
| `file://path/to/plugin` | **Tier 2** (trusted)          | Local files are under the user's control |
| `npm:package-name`      | **Tier 1 + Tier 3** (sandbox) | Third-party code, not user-controlled    |
| `github:user/repo`      | **Tier 1 + Tier 3** (sandbox) | Third-party code from external source    |
| URL-sourced plugins     | **Tier 1 + Tier 3** (sandbox) | Remote source, not user-controlled       |

> **Note:** "Tier 1 + Tier 3" means the plugin's declarative contributions (themes, icons, tool card metadata) are always available at Tier 1, while its interactive UI components (panels, settings, tool renderers) run in Tier 3 sandboxed iframes.

### User Elevation

Users can **elevate** a sandbox plugin to Tier 2 in settings. This grants the plugin same-origin access and should only be done after verifying the plugin's source and code quality. Elevation is persistent per plugin ID and stored in user configuration.

---

## Permissions Model

Every plugin can declare required permissions in its `plugin.json` manifest under the `permissions` field. The host uses these declarations to:

1. Show the user what the plugin wants during install (consent display)
2. Enforce access at runtime

### Permission schema

```jsonc
{
  "permissions": {
    "ui": {
      "toolRenderers": false, // Custom tool cards in chat
      "partRenderers": false, // Custom part renderers in chat
      "workspacePanels": false, // Side panels in workspace view
      "globalPanels": false, // Side panels visible globally
      "settings": false, // Settings section in preferences
      "themes": false, // Custom chat themes
      "icons": false, // Custom icon registrations
      "routes": false, // Custom application pages
      "trustedImport": false, // Tier 2: same-origin dynamic import
      "sandboxIframe": false, // Tier 3: sandboxed iframe
    },
    "network": {
      "connectDomains": [], // Domains the plugin may connect to
      "resourceDomains": [], // Domains for fetched resources (iframes, images)
      "frameDomains": [], // Domains allowed in iframe src
    },
    "data": {
      "session": "none", // "none" | "metadata" | "read"
      "workspace": "none", // "none" | "metadata" | "read"
      "config": "plugin", // "plugin" | "global"
    },
    "tools": {
      "invoke": true, // Whether plugin tools can be invoked
      "shell": false, // Whether tools can access the shell
      "filesystem": false, // Whether tools can access the filesystem
    },
  },
}
```

### `ui.*` — Surface permissions

| Field             | What it allows                               | Runtime enforcement   |
| ----------------- | -------------------------------------------- | --------------------- |
| `toolRenderers`   | Render custom tool cards in chat messages    | Registry registration |
| `partRenderers`   | Render custom message parts                  | Registry registration |
| `workspacePanels` | Add panels to the workspace sidebar          | Registry registration |
| `globalPanels`    | Add panels visible across all scopes         | Registry registration |
| `settings`        | Add a section to the settings/preferences UI | Registry registration |
| `themes`          | Register custom chat themes                  | Registry registration |
| `icons`           | Register custom SVG icons                    | Registry registration |
| `routes`          | Add custom application pages                 | Registry registration |
| `trustedImport`   | Load via same-origin dynamic import (Tier 2) | Enforcement in loader |
| `sandboxIframe`   | Load in sandboxed iframe (Tier 3)            | Iframe rendering path |

### `network.*` — Network access

| Field             | What it controls                                                        | Example values           |
| ----------------- | ----------------------------------------------------------------------- | ------------------------ |
| `connectDomains`  | Domains the plugin's code may make network requests to                  | `["api.example.com"]`    |
| `resourceDomains` | Domains the plugin may load resources from (images, fonts, stylesheets) | `["cdn.example.com"]`    |
| `frameDomains`    | Domains the plugin's iframe may embed via `src`                         | `["widget.example.com"]` |

### `data.*` — Data access levels

| Field       | `"none"`                                            | `"metadata"`                                     | `"read"`                          |
| ----------- | --------------------------------------------------- | ------------------------------------------------ | --------------------------------- |
| `session`   | No session access                                   | Read session metadata (title, model, timestamps) | Read full session message content |
| `workspace` | No workspace access                                 | Read file listings and metadata                  | Read workspace file contents      |
| `config`    | Plugin-namespaced config only (default: `"plugin"`) | —                                                | Read global Synergy configuration |

### `tools.*` — Tool execution

| Field        | Default | Risk                                                                              |
| ------------ | ------- | --------------------------------------------------------------------------------- |
| `invoke`     | `true`  | Low — plugin's own tools can be invoked                                           |
| `shell`      | `false` | **High** — spawn shell commands (marked as "Elevated access" in UI)               |
| `filesystem` | `false` | **High** — read/write files outside workspace (marked as "Elevated access" in UI) |

---

## Install Consent Flow

When a user installs a plugin (via `synergy plugin add <spec>` or through a UI-based install), the system shows what the plugin is requesting. The consent display is rendered by `PluginPermissionsDisplay` and shows:

### 1. Permission summary

Grouped by category:

- **UI** — surface permissions the plugin needs (e.g., "Tool renderers in chat", "Custom workspace panels", "Settings page")
- **Network** — domains the plugin needs to connect to (e.g., "Network access to: api.example.com")
- **Data** — data access level (e.g., "Read session data", "Read workspace files", "Access global config")
- **Tools** — elevated tool access with warning badges (e.g., "Invoke shell commands" [Elevated access])

### 2. Trust tier indicator

| Tier             | Indicator text                                                                                    |
| ---------------- | ------------------------------------------------------------------------------------------------- |
| Tier 2 (trusted) | Shield-check icon, "Trusted mode — Can run code in the app with declared permissions."            |
| Tier 3 (sandbox) | Boxes icon, "Sandbox mode — Runs in an isolated iframe — cannot access the application directly." |

### 3. Elevated permissions warning

When a plugin requests `tools.shell` or `tools.filesystem`, an additional warning banner appears:

> **Elevated permissions requested**
> This plugin requests access beyond the UI surface. Review carefully before installing.

### 4. Update diff view

When updating an existing plugin, the permissions display shows changes:

| Tag                       | Meaning                                               |
| ------------------------- | ----------------------------------------------------- |
| `New` (green)             | A permission or domain was added in the new version   |
| `Removed` (strikethrough) | A permission or domain was removed in the new version |

---

## Trust Tier & Permission Interaction

The trust tier and permissions interact as follows:

| Scenario                                    | Tier                                             | UI Loading                                               | Host access                                    | Data access             |
| ------------------------------------------- | ------------------------------------------------ | -------------------------------------------------------- | ---------------------------------------------- | ----------------------- |
| `file://` plugin, no sandbox panels         | Tier 2                                           | Dynamic import                                           | Full SolidJS context                           | Per permissions         |
| `file://` plugin with `sandbox:true` panels | Tier 2 (trusted) + panels load in Tier 3 iframes | Mixed — main entry via import, sandbox panels via iframe | Full context; sandbox panels limited to bridge | Per permissions         |
| `npm:` plugin, sandbox panels               | Tier 3 (sandbox)                                 | All UI via iframe                                        | Bridge only                                    | Mediated through bridge |
| `npm:` plugin, **elevated** to trusted      | Tier 2                                           | Dynamic import                                           | Full SolidJS context                           | Per permissions         |

---

## Reference

### Implementation locations

| Component                         | Path                                                                                             |
| --------------------------------- | ------------------------------------------------------------------------------------------------ |
| Trust tier determination (server) | `packages/synergy/src/server/plugin-routes.ts` — `determineTrustTier()`                          |
| Trust tier schema                 | `packages/synergy/src/server/plugin-routes.ts` — `z.enum(["trusted", "sandbox"])`                |
| Tier 2 bundle loader              | `packages/app/src/plugin/loaders.ts` — `loadPluginBundle()`                                      |
| Tier 3 sandbox shell              | `packages/app/src/plugin/sandbox/sandbox-shell.tsx` — `SandboxShell`                             |
| postMessage bridge protocol       | `packages/app/src/plugin/sandbox/postmessage-bridge.ts` — `BridgeMessage`                        |
| Permission schema                 | `packages/plugin/src/manifest.ts` — `PluginPermissionsSchema`                                    |
| Permissions UI display            | `packages/app/src/plugin/components/plugin-permissions-display.tsx` — `PluginPermissionsDisplay` |
| Plugin lifecycle activation       | `packages/app/src/plugin/lifecycle.ts` — `activatePlugin()`                                      |
| UI contribution types             | `packages/plugin/src/ui.ts`                                                                      |
| UI API version                    | `packages/plugin/src/ui.ts` — `CURRENT_UI_API_VERSION = "2.0.0"`                                 |
