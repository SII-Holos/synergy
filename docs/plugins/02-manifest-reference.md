# PluginManifest — `contributes.ui` Reference

**Audience:** Plugin developers  
**UI API version:** 2.0.0  
**Source of truth:** `packages/plugin/src/manifest.ts` (Zod schema), `packages/app/src/plugin/lifecycle.ts` (activation), `packages/app/src/plugin/registries/*.ts` (registration)

---

## Overview

The `contributes.ui` block in `plugin.json` declares what UI surfaces a plugin contributes to the Synergy web client. The web client fetches all contributions at startup via `GET /api/plugins/ui/contributions`, validates them against the Zod schemas in `@ericsanchezok/synergy-plugin`, and activates each supported surface.

```jsonc
{
  "contributes": {
    "ui": {
      "entry": "dist/ui.js",
      "minUIApiVersion": "2.0.0",
      "toolRenderers": [],
      "partRenderers": [],
      "workspacePanels": [],
      "globalPanels": [],
      "settings": [],
      "chatComponents": [],
      "themes": [],
      "icons": [],
      "routes": [],
      "commands": [],
    },
  },
}
```

All fields under `contributes.ui` are **optional**. The entire block itself is optional.

---

## Top-level Fields

### `entry`

| Field | Type | Required | Default | Constraints |
| `entry` | `string` | No | — | Must match `/^[a-zA-Z0-9_/.-]+\.js$/`, max 256 characters |

The JavaScript bundle file that contains all UI component exports for this plugin. The host loads this file from the plugin's asset server:

```
/plugin/assets/:pluginId/:version/:entry
```

When `sandboxEntry` is not specified on an individual panel, the sandbox iframe resolver uses `"dist/ui.js"` as the fallback entry. Only **trusted** (same-origin) plugins can be dynamically imported via `import()`; sandbox plugins are loaded in iframes.

```jsonc
"entry": "dist/ui.js"
```

### `minUIApiVersion`

| Field             | Type     | Required | Constraints                             |
| ----------------- | -------- | -------- | --------------------------------------- |
| `minUIApiVersion` | `string` | No       | Must match `/^\d+\.\d+\.\d+$/` (semver) |

The minimum UI API version the plugin requires. The host reports its API version via `PluginUIContext.UIApiVersion`. The current host API version is `"2.0.0`. If this field is set to a version higher than the host supports, the plugin's UI contributions should be considered incompatible.

```jsonc
"minUIApiVersion": "2.0.0"
```

---

## Array Fields

### `toolRenderers[]`

Custom card renderers for tool invocations in the chat message stream. Each renderer replaces the default tool card display for a specific tool name.

**TypeScript type (inferred from Zod):**

```typescript
{
  tool: string
  exportName?: string     // default: "default"
  priority?: number       // 0–100, default: 0
  fallback?: {
    icon?: string
    title?: string
    subtitleTemplate?: string
  }
}
```

**Fields:**

| Field                       | Type     | Required | Default     | Description                                                                                      |
| --------------------------- | -------- | -------- | ----------- | ------------------------------------------------------------------------------------------------ |
| `tool`                      | `string` | Yes      | —           | Tool name this renderer handles                                                                  |
| `exportName`                | `string` | No       | `"default"` | Named export from the UI bundle that exports the renderer component                              |
| `priority`                  | `number` | No       | `0`         | Display priority (higher = preferred when multiple renderers match the same tool). Must be 0–100 |
| `fallback`                  | `object` | No       | —           | Static fallback metadata shown before the bundle is loaded                                       |
| `fallback.icon`             | `string` | No       | —           | Lucide icon name for the fallback display                                                        |
| `fallback.title`            | `string` | No       | —           | Title string for the fallback display                                                            |
| `fallback.subtitleTemplate` | `string` | No       | —           | Subtitle template (may support interpolation)                                                    |

The renderer component receives `PluginToolRendererProps`:

```typescript
interface PluginToolRendererProps {
  input: Record<string, unknown>
  metadata: Record<string, unknown>
  tool: string
  title?: string
  output?: string
  status?: string
  raw?: string
  charsReceived?: number
  hideDetails?: boolean
  defaultOpen?: boolean
  forceOpen?: boolean
}
```

**Example:**

```jsonc
{
  "tool": "read_file",
  "exportName": "ReadFileRenderer",
  "priority": 50,
  "fallback": {
    "icon": "file-text",
    "title": "Read File",
    "subtitleTemplate": "{{path}}",
  },
}
```

---

### `partRenderers[]`

Custom renderers for message parts (non-tool content blocks within chat messages).

**TypeScript type:**

```typescript
{
  type: string
  exportName?: string    // default: "default"
  priority?: number      // 0–100, default: 0
}
```

**Fields:**

| Field        | Type     | Required | Default     | Description                                |
| ------------ | -------- | -------- | ----------- | ------------------------------------------ |
| `type`       | `string` | Yes      | —           | Part type identifier this renderer handles |
| `exportName` | `string` | No       | `"default"` | Named export from the UI bundle            |
| `priority`   | `number` | No       | `0`         | Display priority. Must be 0–100            |

The renderer component receives `PluginPartRendererProps`:

```typescript
interface PluginPartRendererProps {
  part: Record<string, unknown>
  message: Record<string, unknown>
}
```

**Example:**

```jsonc
{
  "type": "image",
  "exportName": "ImagePartRenderer",
  "priority": 50,
}
```

---

### `workspacePanels[]`

Side panels shown in the workspace/project view.

**TypeScript type:**

```typescript
{
  id: string
  label: string
  icon: string
  exportName?: string    // default: "default"
  sandbox?: boolean      // default: false
  sandboxEntry?: string  // regex: /^[a-zA-Z0-9_/.-]+\.js$/, max 256 chars
}
```

**Fields:**

| Field          | Type      | Required | Default                  | Description                                                                                     |
| -------------- | --------- | -------- | ------------------------ | ----------------------------------------------------------------------------------------------- |
| `id`           | `string`  | Yes      | —                        | Panel identifier (1–64 chars). Scoped at runtime to `pluginId:panelId`                          |
| `label`        | `string`  | Yes      | —                        | Human-readable label (1–64 chars)                                                               |
| `icon`         | `string`  | Yes      | —                        | Lucide icon name                                                                                |
| `exportName`   | `string`  | No       | `"default"`              | Named export from the UI bundle                                                                 |
| `sandbox`      | `boolean` | No       | `false`                  | If `true`, render in a sandboxed iframe (Tier 3). Requires `permissions.ui.sandboxIframe: true` |
| `sandboxEntry` | `string`  | No       | Falls back to `ui.entry` | JS bundle to load inside the sandbox iframe. Must end in `.js`                                  |

The panel component receives `PluginPanelProps`:

```typescript
interface PluginPanelProps {
  pluginId: string
  panelId: string
  scope?: { type: "global" | "project"; id: string; directory: string }
  sessionId?: string
}
```

**Example:**

```jsonc
{
  "id": "my-panel",
  "label": "My Panel",
  "icon": "activity",
  "exportName": "MyPanelComponent",
  "sandbox": false,
}
```

---

### `globalPanels[]`

Side panels shown in the home/global view (outside any project context). Same shape as `workspacePanels[]`.

**TypeScript type:** Identical to `workspacePanels[]` (`PanelDef`).

**Fields:** Same as `workspacePanels[]`.

**Example:**

```jsonc
{
  "id": "global-dashboard",
  "label": "Dashboard",
  "icon": "layout-dashboard",
  "sandbox": true,
  "sandboxEntry": "dist/sandbox/dashboard.js",
}
```

---

### `settings[]`

Settings sections added to the Settings dialog.

**TypeScript type:**

```typescript
{
  id: string
  label: string
  icon: string
  group: string
  formSchema?: Record<string, unknown>
  exportName?: string
  sandbox?: boolean         // default: false
  sandboxEntry?: string     // regex: /^[a-zA-Z0-9_/.-]+\.js$/, max 256 chars
}
```

**Fields:**

| Field          | Type      | Required | Default                  | Description                                                                                             |
| -------------- | --------- | -------- | ------------------------ | ------------------------------------------------------------------------------------------------------- |
| `id`           | `string`  | Yes      | —                        | Section identifier (1–64 chars). Scoped at runtime to `pluginId:sectionId`                              |
| `label`        | `string`  | Yes      | —                        | Human-readable label (1–64 chars)                                                                       |
| `icon`         | `string`  | Yes      | —                        | Lucide icon name                                                                                        |
| `group`        | `string`  | Yes      | —                        | Group name for organizing sections in the settings sidebar                                              |
| `formSchema`   | `object`  | No       | —                        | JSON Schema-compatible form definition for auto-generated settings UI                                   |
| `exportName`   | `string`  | No       | —                        | Named export from the UI bundle. When omitted, the host shows the auto-generated form from `formSchema` |
| `sandbox`      | `boolean` | No       | `false`                  | If `true`, render in a sandboxed iframe                                                                 |
| `sandboxEntry` | `string`  | No       | Falls back to `ui.entry` | JS bundle for the sandbox iframe                                                                        |

The settings panel component (when `exportName` is provided) receives `PluginSettingsPanelProps`:

```typescript
interface PluginSettingsPanelProps {
  pluginId: string
  config: Record<string, unknown>
  onConfigChange: (values: Record<string, unknown>) => Promise<void>
}
```

**Example:**

```jsonc
{
  "id": "preferences",
  "label": "Plugin Preferences",
  "icon": "settings",
  "group": "Plugins",
  "formSchema": {
    "type": "object",
    "properties": {
      "theme": {
        "type": "string",
        "enum": ["light", "dark", "auto"],
        "default": "auto",
      },
    },
  },
}
```

---

### `chatComponents[]`

Custom UI components injected into the chat message stream at specific slots.

**TypeScript type:**

```typescript
{
  id: string
  exportName?: string                          // default: "default"
  slot?: "before-tools" | "after-tools" | "before-reasoning" | "after-reasoning"
}
```

**Fields:**

| Field        | Type     | Required | Default         | Description                                                                                                               |
| ------------ | -------- | -------- | --------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `id`         | `string` | Yes      | —               | Component identifier                                                                                                      |
| `exportName` | `string` | No       | `"default"`     | Named export from the UI bundle                                                                                           |
| `slot`       | `enum`   | No       | `"after-tools"` | Position in the chat message layout. One of: `"before-tools"`, `"after-tools"`, `"before-reasoning"`, `"after-reasoning"` |

The chat component receives `PluginChatComponentProps`:

```typescript
interface PluginChatComponentProps {
  pluginId: string
  message: Record<string, unknown>
  parts: Record<string, unknown>[]
  sessionId: string
}
```

**Example:**

```jsonc
{
  "id": "translation-toolbar",
  "exportName": "TranslationToolbar",
  "slot": "before-reasoning",
}
```

---

### `themes[]`

Custom theme definitions that change the appearance of the web client.

**TypeScript type:**

```typescript
{
  id: string
  label: string
  path: string
}
```

**Fields:**

| Field   | Type     | Required | Description                                                                |
| ------- | -------- | -------- | -------------------------------------------------------------------------- |
| `id`    | `string` | Yes      | Theme identifier (1–64 chars). Scoped at runtime to `pluginId:themeId`     |
| `label` | `string` | Yes      | Human-readable label (1–64 chars)                                          |
| `path`  | `string` | Yes      | Relative path to a CSS file containing CSS custom properties for the theme |

The `path` is resolved from the plugin's asset server. The CSS file should define CSS custom properties (variables) on `:root` to override the default theme.

```jsonc
{
  "id": "synthwave",
  "label": "Synthwave",
  "path": "themes/synthwave.css",
}
```

---

### `icons[]`

Custom Lucide-compatible icon definitions contributed by the plugin.

**TypeScript type:**

```typescript
{
  name: string
  path: string
}
```

**Fields:**

| Field  | Type     | Required | Description                                                       |
| ------ | -------- | -------- | ----------------------------------------------------------------- |
| `name` | `string` | Yes      | Icon name (1–128 chars). Scoped at runtime to `pluginId:iconName` |
| `path` | `string` | Yes      | Relative path to an SVG file for the icon                         |

The SVG file is served from the plugin's asset server. Icons are registered in the web client's icon registry and can be referenced by their scoped name.

```jsonc
{
  "name": "star-outline",
  "path": "icons/star-outline.svg",
}
```

---

### `routes[]`

Custom page routes available in the web client.

**TypeScript type:**

```typescript
{
  path: string
  entry: string
  label: string
  icon?: string
}
```

**Fields:**

| Field   | Type     | Required | Description                                                                              |
| ------- | -------- | -------- | ---------------------------------------------------------------------------------------- |
| `path`  | `string` | Yes      | Route path (appended to `/plugin/:pluginId/` at runtime). Must not contain leading slash |
| `entry` | `string` | Yes      | HTML file path from the plugin directory for this route                                  |
| `label` | `string` | Yes      | Human-readable label for navigation                                                      |
| `icon`  | `string` | No       | Lucide icon name for navigation                                                          |

The route path becomes `/plugin/:pluginId/:path` in the web client. The `entry` is an HTML file served from the plugin's directory (not from the UI bundle).

```jsonc
{
  "path": "analytics",
  "entry": "pages/analytics.html",
  "label": "Analytics",
  "icon": "bar-chart",
}
```

---

### `commands[]`

Custom UI commands that can be invoked from the web client (e.g., via command palette or keyboard shortcuts).

**TypeScript type:**

```typescript
{
  id: string
  label: string
  exportName?: string
  description?: string    // max 256 chars
  icon?: string
}
```

**Fields:**

| Field         | Type     | Required | Description                                                    |
| ------------- | -------- | -------- | -------------------------------------------------------------- |
| `id`          | `string` | Yes      | Command identifier (1–64 chars)                                |
| `label`       | `string` | Yes      | Display label (1–64 chars)                                     |
| `exportName`  | `string` | No       | Named export from the UI bundle (the command handler function) |
| `description` | `string` | No       | Short description (max 256 chars)                              |
| `icon`        | `string` | No       | Lucide icon name                                               |

```jsonc
{
  "id": "toggle-dark-mode",
  "label": "Toggle Dark Mode",
  "exportName": "toggleDarkMode",
  "description": "Switch between light and dark themes",
  "icon": "moon",
}
```

---

## `permissions` Schema

The `permissions` field at the top level of `plugin.json` declares what capabilities the plugin requires. The web client enforces these at runtime.

```jsonc
{
  "permissions": {
    "ui": { ... },
    "network": { ... },
    "data": { ... },
    "tools": { ... }
  }
}
```

All permission fields are optional and default to safe values.

### `permissions.ui`

Controls which UI surfaces the plugin is allowed to contribute.

| Field             | Type      | Default | Description                                                                                                                              |
| ----------------- | --------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `toolRenderers`   | `boolean` | `false` | Allow contributing tool renderers                                                                                                        |
| `partRenderers`   | `boolean` | `false` | Allow contributing part renderers                                                                                                        |
| `workspacePanels` | `boolean` | `false` | Allow contributing workspace panels                                                                                                      |
| `globalPanels`    | `boolean` | `false` | Allow contributing global panels                                                                                                         |
| `settings`        | `boolean` | `false` | Allow contributing settings sections                                                                                                     |
| `themes`          | `boolean` | `false` | Allow contributing themes                                                                                                                |
| `icons`           | `boolean` | `false` | Allow contributing icons                                                                                                                 |
| `routes`          | `boolean` | `false` | Allow contributing routes                                                                                                                |
| `trustedImport`   | `boolean` | `false` | Allow Tier 2 trusted host import (same-origin JS execution). When `true`, the plugin's JS bundle is imported directly into the host page |
| `sandboxIframe`   | `boolean` | `false` | Allow Tier 3 sandbox iframe. When `true`, the plugin's UI can be loaded in a sandboxed iframe with restricted capabilities               |

```jsonc
"ui": {
  "toolRenderers": true,
  "workspacePanels": true,
  "trustedImport": true
}
```

### `permissions.network`

Controls network access.

| Field             | Type       | Default | Description                                                                |
| ----------------- | ---------- | ------- | -------------------------------------------------------------------------- |
| `connectDomains`  | `string[]` | `[]`    | Domains the plugin may connect to (e.g., API servers)                      |
| `resourceDomains` | `string[]` | `[]`    | Domains the plugin may fetch resources from (iframes, images, stylesheets) |
| `frameDomains`    | `string[]` | `[]`    | Domains allowed in iframe `src` attributes                                 |

```jsonc
"network": {
  "connectDomains": ["api.example.com"],
  "resourceDomains": ["cdn.example.com"]
}
```

### `permissions.data`

Controls data access levels.

| Field       | Type                                 | Default    | Description                                                                                |
| ----------- | ------------------------------------ | ---------- | ------------------------------------------------------------------------------------------ |
| `session`   | `"none"` \| `"metadata"` \| `"read"` | `"none"`   | Access to session data. `"metadata"` = titles and timestamps only. `"read"` = full content |
| `workspace` | `"none"` \| `"metadata"` \| `"read"` | `"none"`   | Access to workspace files                                                                  |
| `config`    | `"plugin"` \| `"global"`             | `"plugin"` | Config access scope. `"plugin"` = own config only. `"global"` = all config                 |

```jsonc
"data": {
  "session": "read",
  "config": "plugin"
}
```

### `permissions.tools`

Controls tool execution permissions for server-side plugin tools.

| Field        | Type      | Default | Description                                    |
| ------------ | --------- | ------- | ---------------------------------------------- |
| `invoke`     | `boolean` | `true`  | Whether plugin tools can be invoked            |
| `shell`      | `boolean` | `false` | Whether plugin tools can access the shell      |
| `filesystem` | `boolean` | `false` | Whether plugin tools can access the filesystem |

```jsonc
"tools": {
  "invoke": true,
  "shell": false,
  "filesystem": true
}
```

---

## Trust Tiers

The server classifies each plugin's trust tier based on its installation location:

| Tier   | Name              | Description                                                                                                                         |
| ------ | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Tier 1 | `trusted`         | Locally installed plugin (path outside cache). JS bundle is imported via dynamic `import()` (same-origin). Full access to host APIs |
| Tier 2 | — (Tier 2 subset) | Trusted imports that only load specific components from the bundle when `trustedImport: true` is declared                           |
| Tier 3 | `sandbox`         | Plugin installed from cache (npm registry). UI rendered in sandboxed iframe. Communication via `postMessage` bridge                 |

Determination logic: If the plugin directory is under the runtime cache root, it is `"sandbox"`; otherwise it is `"trusted"`.

---

## Server API Endpoints

The server exposes the following endpoints related to plugin UI contributions:

| Method | Path                                       | Description                                       |
| ------ | ------------------------------------------ | ------------------------------------------------- |
| GET    | `/api/plugins/ui/contributions`            | List all plugins' UI contributions (aggregated)   |
| GET    | `/api/plugins/assets/:pluginId/:version/*` | Serve plugin static assets with immutable cache   |
| GET    | `/api/plugins/:pluginId/sandbox/:panelId`  | Serve sandbox iframe HTML shell for a panel       |
| POST   | `/api/plugins/:pluginId/interact`          | Relay postMessage interaction from sandbox iframe |

The contributions endpoint returns:

```typescript
{
  pluginId: string
  name?: string
  version: string
  trustTier: "trusted" | "sandbox"
  ui: UIContribution | null
  permissions: PluginPermissions | null
}[]
```

---

## Activation Lifecycle

1. The web client calls `GET /api/plugins/ui/contributions` at startup.
2. For each plugin with a `ui` block, the client iterates each contribution array.
3. Each item is registered in the appropriate registry with a scoped identifier (`pluginId:itemId`).
4. For **trusted** plugins, component exports are lazily loaded via `import()` when first needed.
5. For **sandbox** plugins, UI is rendered in iframes using the sandbox shell endpoint.
6. Disposers are returned for each registration, allowing clean deactivation when a plugin is removed.

---

## Full Example

```jsonc
{
  "name": "example-plugin",
  "version": "1.0.0",
  "permissions": {
    "ui": {
      "toolRenderers": true,
      "workspacePanels": true,
      "trustedImport": true,
    },
    "data": {
      "session": "read",
      "config": "plugin",
    },
  },
  "contributes": {
    "ui": {
      "entry": "dist/ui.js",
      "minUIApiVersion": "2.0.0",
      "toolRenderers": [
        {
          "tool": "read_file",
          "exportName": "ReadFileRenderer",
          "priority": 50,
          "fallback": {
            "icon": "file-text",
            "title": "Read File",
            "subtitleTemplate": "{{path}}",
          },
        },
      ],
      "workspacePanels": [
        {
          "id": "activity-feed",
          "label": "Activity",
          "icon": "activity",
          "exportName": "ActivityPanel",
        },
      ],
      "globalPanels": [
        {
          "id": "dashboard",
          "label": "Dashboard",
          "icon": "layout-dashboard",
          "sandbox": true,
          "sandboxEntry": "dist/sandbox/dashboard.js",
        },
      ],
      "settings": [
        {
          "id": "prefs",
          "label": "Example Plugin",
          "icon": "settings",
          "group": "Plugins",
          "formSchema": {
            "type": "object",
            "properties": {
              "theme": {
                "type": "string",
                "enum": ["light", "dark"],
                "default": "light",
              },
            },
          },
        },
      ],
      "chatComponents": [
        {
          "id": "inline-translator",
          "exportName": "InlineTranslator",
          "slot": "after-tools",
        },
      ],
      "themes": [
        {
          "id": "synthwave",
          "label": "Synthwave",
          "path": "themes/synthwave.css",
        },
      ],
      "icons": [
        {
          "name": "custom-star",
          "path": "icons/star.svg",
        },
      ],
      "routes": [
        {
          "path": "analytics",
          "entry": "pages/analytics.html",
          "label": "Analytics",
          "icon": "bar-chart",
        },
      ],
      "commands": [
        {
          "id": "toggle-mode",
          "label": "Toggle Mode",
          "exportName": "toggleMode",
          "description": "Switch between light and dark modes",
          "icon": "moon",
        },
      ],
    },
  },
}
```
