# Migration Guide: From Hardcoded UI to Plugin System

This guide describes how to migrate from the older pattern of hardcoded UI
registrations — inline `ToolRegistry.register()` calls, statically defined
panel/settings arrays — to the declarative plugin manifest system.

> **Audience:** Developers migrating built-in tool renderers, panels,
> settings, or other UI contributions to the plugin manifests.

---

## What changed

### Before (hardcoded)

```ts
// packages/ui/src/components/tool-renders.tsx
ToolRegistry.register({
  name: "my_tool",
  render(props) {
    /* ... */
  },
})
```

```ts
// packages/app/src/plugin/registries/panel-registry.ts
const BUILTIN_PANELS = [{ id: "engram", label: "Library", icon: "book-open", pluginId: "" }]
```

Every tool renderer, panel, settings section, and route was registered
imperatively in the host codebase. Adding a new capability meant editing
source files and re-building the application.

### After (declarative)

```jsonc
// plugin.json
{
  "contributes": {
    "ui": {
      "toolRenderers": [{ "tool": "my_tool", "priority": 10 }],
      "workspacePanels": [{ "id": "my-panel", "label": "My Panel", "icon": "box" }],
    },
  },
}
```

The server serves aggregated contributions from `GET /api/plugins/ui/contributions`.
The frontend fetches them once at startup and registers each contribution
into the same registries that previously were populated by hardcoded code.

---

## Migration overview

```
┌─────────────────────────────────────────────────────┐
│                   Before                             │
│                                                      │
│  tool-renders.tsx (ToolRegistry.register calls)      │
│  panel-registry.ts (BUILTIN_PANELS array)            │
│  settings-registry.ts (BUILTIN_SECTIONS array)       │
│  semantic-tool-classifier.ts (TOOL_CATEGORIES map)   │
│  icon.tsx (icons import map)                         │
│  taxonomy.ts (REGISTRY map)                          │
└──────────────────────┬──────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────┐
│                   After                              │
│                                                      │
│  plugin.json (declarative manifest)                  │
│    → toolRenderers array                             │
│    → panels/settings/themes/icons/routes             │
│    → permissions declaration                         │
│                                                      │
│  Server routes aggregate contributions               │
│  Frontend registries consume from /api/plugins/ui    │
│  Backward compat: old registries still work          │
└─────────────────────────────────────────────────────┘
```

---

## Step-by-step: Extract a tool renderer

### Step 1: Create the plugin package

```bash
mkdir my-plugin
cd my-plugin
bun init
bun add @ericsanchezok/synergy-plugin zod
```

### Step 2: Move the renderer to the plugin

**Before:** In `packages/ui/src/components/tool-renders.tsx`:

```tsx
ToolRegistry.register({
  name: "my_tool",
  render(props) {
    return (
      <BasicTool
        {...props}
        icon="box"
        trigger={() => ({
          title: "My Tool",
          subtitle: props.input.query,
        })}
      >
        <Show when={props.output}>
          {(output) => (
            <div data-component="tool-output" data-scrollable>
              <ToolTextOutput text={output()} />
            </div>
          )}
        </Show>
      </BasicTool>
    )
  },
})
```

**After** in `my-plugin/src/ui.tsx`:

```tsx
import type { PluginToolRenderer } from "@ericsanchezok/synergy-plugin"
import type { Component } from "solid-js"

const MyToolRenderer: Component<PluginToolRenderer> = (props) => {
  return (
    <BasicTool
      {...props}
      icon="box"
      trigger={() => ({
        title: "My Tool",
        subtitle: props.input.query,
      })}
    >
      <Show when={props.output}>
        {(output) => (
          <div data-component="tool-output" data-scrollable>
            <ToolTextOutput text={output()} />
          </div>
        )}
      </Show>
    </BasicTool>
  )
}

export default MyToolRenderer
```

### Step 3: Declare in the manifest (`plugin.json`)

```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "description": "Provides custom tool renderers",
  "contributes": {
    "ui": {
      "entry": "dist/ui.js",
      "toolRenderers": [
        {
          "tool": "my_tool",
          "exportName": "default",
          "priority": 50,
          "fallback": {
            "icon": "box",
            "title": "My Tool",
            "subtitleTemplate": "{{input.query}}"
          }
        }
      ]
    }
  }
}
```

The `fallback` block provides metadata for Tier 1 (declarative) rendering
when the plugin is sandboxed or the bundle hasn't loaded yet. It mirrors
the `getToolInfo()` switch-case entries from `message-part.tsx`.

### Step 4: Remove from the hardcoded registries

After verifying the plugin works, delete the corresponding `ToolRegistry.register()`
call from `packages/ui/src/components/tool-renders.tsx` and remove the tool's
entry from the `TOOL_CATEGORIES` map in
`packages/ui/src/components/semantic-tool-classifier.ts`.

### Step 5: Build and test

```bash
cd my-plugin
bun run build   # produces dist/ui.js
```

Add the plugin to your `synergy.jsonc`:

```jsonc
{
  "plugin": ["file:///path/to/my-plugin"],
}
```

Restart the server, confirm the renderer appears in the chat.

---

## Step-by-step: Extract a panel or settings section

### Step 1: Declare in the manifest

```json
{
  "contributes": {
    "ui": {
      "entry": "dist/ui.js",
      "workspacePanels": [
        {
          "id": "analytics-dashboard",
          "label": "Analytics",
          "icon": "bar-chart",
          "sandbox": true,
          "sandboxEntry": "dist/analytics.js"
        }
      ],
      "settings": [
        {
          "id": "analytics-config",
          "label": "Analytics Config",
          "icon": "settings",
          "group": "Integrations",
          "sandbox": true,
          "sandboxEntry": "dist/analytics-settings.js"
        }
      ]
    }
  }
}
```

### Step 2: Remove from hardcoded panel/settings arrays

**Before** (`packages/app/src/plugin/registries/panel-registry.ts`):

```ts
const BUILTIN_PANELS: GlobalPanelEntry[] = [{ id: "analytics", label: "Analytics", icon: "bar-chart", pluginId: "" }]
```

**After:** Delete the entry. The `discoverAndActivate` flow in
`packages/app/src/plugin/lifecycle.ts` will register it automatically.

For settings, remove from `BUILTIN_SECTIONS` in
`packages/app/src/plugin/registries/settings-registry.ts`.

### Step 3: Verify

Check that the panel appears in the UI after a server restart. The frontend
fetches contributions from `GET /api/plugins/ui/contributions` and calls
`registerWorkspacePanel` / `registerGlobalPanel` / `registerSettingsSection`
for each declared entry.

---

## What the server does

`GET /api/plugins/ui/contributions` returns aggregated manifests:

```json
[
  {
    "pluginId": "my-plugin",
    "name": "My Plugin",
    "version": "1.0.0",
    "trustTier": "trusted",
    "ui": {
      "entry": "dist/ui.js",
      "toolRenderers": [
        /* ... */
      ],
      "workspacePanels": [
        /* ... */
      ],
      "settings": [
        /* ... */
      ]
    },
    "permissions": { "ui": { "trustedImport": true } }
  }
]
```

The frontend then:

1. Fetches contributions at startup via `fetchContributions()`
2. Calls `activatePlugin()` for each contribution
3. `activatePlugin()` reads `trustTier`:
   - **Trusted** plugins: registers a `loader` callback that does a dynamic
     `import()` of the plugin's JS bundle from `/plugin/assets/...`
   - **Sandbox** plugins: registers only fallback metadata; the actual
     rendering happens inside an iframe
4. Registers into the appropriate registry (tool, panel, settings, etc.)

---

## Mapping old patterns to new

### Tool registries

| Old location                                    | New manifest field                     |
| ----------------------------------------------- | -------------------------------------- |
| `tool-renders.tsx` → `ToolRegistry.register()`  | `contributes.ui.toolRenderers[]`       |
| `message-part.tsx` → `getToolInfo()` cases      | `toolRenderers[].fallback` block       |
| `semantic-tool-classifier.ts` → TOOL_CATEGORIES | Shared fallback — remove when migrated |

### Panel registries

| Old location                               | New manifest field                 |
| ------------------------------------------ | ---------------------------------- |
| `panel-registry.ts` → BUILTIN_PANELS       | `contributes.ui.globalPanels[]`    |
| `workspace-registry.ts` → built-in entries | `contributes.ui.workspacePanels[]` |

### Settings registries

| Old location                              | New manifest field          |
| ----------------------------------------- | --------------------------- |
| `settings-registry.ts` → BUILTIN_SECTIONS | `contributes.ui.settings[]` |

### Other registries

| Old pattern                           | New manifest field                |
| ------------------------------------- | --------------------------------- |
| Dynamic `import()` of theme CSS       | `contributes.ui.themes[]`         |
| Manual Lucide icon import in icon.tsx | `contributes.ui.icons[]`          |
| Imperative route additions            | `contributes.ui.routes[]`         |
| Chat component slot registrations     | `contributes.ui.chatComponents[]` |

---

## What the `TierPlugin` (formerly `PluginToolBridge`) handles

The `PluginToolBridge` (in `packages/app/src/plugin/bridge.ts`) wires the
external plugin registries into the UI's `ToolRegistry`:

- `setExternalToolLookup(getToolRenderer)` — routes tool render requests to
  the plugin tool-registry after built-in lookups miss
- `setExternalFallbackLookup(getToolFallback)` — routes declarative metadata
  lookups (icon, title, subtitleTemplate) for tools that have no loaded
  renderer yet

This means a tool renderer can be registered from a plugin and appear in the
chat UI without any hardcoded import or switch-case.

---

## Backward compatibility

### Old registries still work

The registries in `packages/app/src/plugin/registries/` are additive. The
`discoverAndActivate()` flow adds plugin contributions on top of the existing
hardcoded entries (BUILTIN_PANELS, BUILTIN_SECTIONS). Removing an entry from
the built-in arrays simply means it must come from a plugin instead.

### ToolRegistry in the UI package still works

The `ToolRegistry` in `packages/ui/src/components/message-part.tsx` is the
lowest-level registry. Plugin tool renderers are registered into the
`packages/app/src/plugin/registries/tool-registry.ts`, which falls back to
`ToolRegistry.render()` when no plugin renderer is found. This means:

- Existing `ToolRegistry.register()` calls continue to work
- Plugin tool renderers take priority when registries overlap
- Migration can be incremental: move one tool at a time

### The `getToolInfo()` switch statement

The `getToolInfo()` function in `message-part.tsx` provides declarative
metadata (icon, title, subtitle) for tool cards. New plugin tools provide
this through the `fallback` block in the manifest instead. The
`getToolFallback()` lookup is checked before the switch statement.

For backward compatibility, the switch statement still handles all the legacy
tools. When a tool is migrated to a plugin, its `getToolInfo()` case should
be removed.

### The `TOOL_CATEGORIES` map

The `semantic-tool-classifier.ts` `TOOL_CATEGORIES` map provides semantic
classification for unregistered tools. When migrating a tool to a plugin,
remove its entry from this map so the classification comes from the manifest
instead.

---

## Real-world example: SII Inspire tools (conceptual)

The `inspire_*` tools (inspire_status, inspire_submit, inspire_jobs, etc.)
are a good candidate for migration:

**Before:**

- 15+ `ToolRegistry.register()` calls in `tool-renders.tsx`
- 15+ `getToolInfo()` cases in `message-part.tsx`
- 15+ `TOOL_CATEGORIES` entries in `semantic-tool-classifier.ts`
- 15+ `REGISTRY` entries in `taxonomy.ts`
- Icon imports in `icon.tsx`

**After:**

- One plugin manifest with `toolRenderers[]` array with 15 entries
- One JS bundle with 15 SolidJS renderer components
- Host registries are populated from `GET /api/plugins/ui/contributions`

The migration steps for inspire would be:

1. Create a `holos-inspire` plugin package
2. Copy each tool renderer from `tool-renders.tsx` into the plugin's UI bundle
3. Create the manifest with `toolRenderers[]`, `permissions { ui: { trustedImport: true } }`
4. Remove the entries from:
   - `tool-renders.tsx` (all `ToolRegistry.register()` calls)
   - `message-part.tsx` (all `inspire_*` cases in `getToolInfo()`)
   - `semantic-tool-classifier.ts` (all `inspire_*` entries)
   - `taxonomy.ts` (all `inspire_*` entries)
   - `icon.tsx` (no longer needed in the host bundle)
5. Add the plugin to the server's plugin config
6. Restart and verify

---

## Checklist for migrating a tool to a plugin

- [ ] Create plugin directory with `package.json` and `tsconfig.json`
- [ ] Extract the renderer component into the plugin's UI source
- [ ] Create `plugin.json` with the tool renderer declaration
- [ ] Set `permissions.ui.trustedImport` for trusted plugins
- [ ] Build the plugin bundle (e.g., `dist/ui.js`)
- [ ] Remove the `ToolRegistry.register()` call from `tool-renders.tsx`
- [ ] Remove the `getToolInfo()` case from `message-part.tsx`
- [ ] Remove the `TOOL_CATEGORIES` entry from `semantic-tool-classifier.ts`
- [ ] Remove the `REGISTRY` entry from `taxonomy.ts`
- [ ] Remove the Lucide icon import from `icon.tsx` (if no other tool uses it)
- [ ] Add the plugin path to `synergy.jsonc` → `plugin` array
- [ ] Restart the server and test
- [ ] Remove the icon mapping from `icon.tsx`'s `icons` map (if the icon is
      plugin-specific and not shared)

## Checklist for migrating a panel/settings section

- [ ] Declare the panel/settings in `plugin.json` under `contributes.ui`
- [ ] Set `sandbox: true` for registry-published plugins
- [ ] Create the panel component in the plugin's UI bundle
- [ ] Remove from `BUILTIN_PANELS` / `BUILTIN_SECTIONS`
- [ ] Restart and verify the panel appears
