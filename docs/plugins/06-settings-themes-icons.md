# Settings Pages, Themes, and Icons

This guide covers three UI contribution types: **settings pages** (user-configurable options for your plugin), **themes** (color scheme overrides), and **icons** (custom SVG graphics).

---

## Settings pages

Settings pages let users configure plugin options from the Synergy Web client's settings dialog (gear icon in the sidebar). The platform supports three tiers of settings implementations, matching the general [trust tier model](01-platform-overview.md#trust-tiers).

### Tier 1: Declarative (JSON Schema form)

The simplest approach. Declare a `formSchema` in `plugin.json` and the host auto-generates a form with text inputs, checkboxes, number inputs, select dropdowns (from enum), and password fields. No frontend code required.

**`plugin.json`:**

```json
{
  "contributes": {
    "ui": {
      "settings": [
        {
          "id": "general",
          "label": "General",
          "icon": "sliders-horizontal",
          "group": "My Plugin",
          "formSchema": {
            "type": "object",
            "properties": {
              "apiKey": {
                "type": "string",
                "title": "API Key",
                "description": "Your API key for the external service",
                "format": "password"
              },
              "maxResults": {
                "type": "number",
                "title": "Max Results",
                "description": "Maximum number of results per request",
                "default": 25
              },
              "enableNotifications": {
                "type": "boolean",
                "title": "Enable Notifications",
                "default": true
              },
              "theme": {
                "type": "string",
                "title": "Color Theme",
                "enum": ["light", "dark", "system"]
              }
            }
          }
        }
      ]
    }
  }
}
```

The host renders these fields using the `DeclarativeSettingsForm` component, which supports:

| `type` value                   | Input control       | Notes                           |
| ------------------------------ | ------------------- | ------------------------------- |
| `string`                       | text `<input>`      |                                 |
| `string` + `"password"` format | password `<input>`  | Masked input for secrets        |
| `number`                       | number `<input>`    |                                 |
| `boolean`                      | checkbox `<input>`  |                                 |
| any type + `enum` array        | `<select>` dropdown | Works with string, number types |

Changes are debounced (500 ms) and automatically persisted to the plugin's scoped config via the host's config API.

**Permission requirement:** `permissions.ui.settings: true`.

### Tier 2: Custom Solid component

When the declarative form is insufficient (custom layout, interactive controls, visual previews), provide a Solid.js component as a named export in your UI bundle.

**`plugin.json`:**

```json
{
  "permissions": {
    "ui": {
      "settings": true,
      "trustedImport": true
    }
  },
  "contributes": {
    "ui": {
      "entry": "ui/index.js",
      "settings": [
        {
          "id": "advanced",
          "label": "Advanced",
          "icon": "cpu",
          "group": "My Plugin",
          "exportName": "AdvancedSettings"
        }
      ]
    }
  }
}
```

**`ui/AdvancedSettings.tsx`:**

```tsx
import type { Component } from "solid-js"
import type { PluginSettingsPanelProps } from "@ericsanchezok/synergy-plugin"

const AdvancedSettings: Component<PluginSettingsPanelProps> = (props) => {
  return (
    <div class="settings-panel">
      <h3>Advanced Configuration</h3>
      <label>
        Cache TTL (seconds)
        <input
          type="number"
          value={props.config.cacheTtl ?? 300}
          onChange={(e) =>
            props.onConfigChange({
              ...props.config,
              cacheTtl: Number(e.currentTarget.value),
            })
          }
        />
      </label>
    </div>
  )
}

export default AdvancedSettings
```

Your component receives `PluginSettingsPanelProps`:

```ts
interface PluginSettingsPanelProps {
  pluginId: string
  config: Record<string, unknown> // current config values
  onConfigChange: (values: Record<string, unknown>) => Promise<void> // host deep-merges and persists
}
```

The host lazy-loads the component from your plugin's UI bundle when the user navigates to this settings section. Requires `trustedImport: true` in permissions — see [Trust Tiers](01-platform-overview.md#trust-tiers) for availability.

**Permission requirement:** `permissions.ui.settings: true` + `permissions.ui.trustedImport: true`.

### Tier 3: Sandbox iframe

For plugins that need full isolation, provide a sandboxed iframe settings page. The iframe communicates with the host over `postMessage`.

**`plugin.json`:**

```json
{
  "permissions": {
    "ui": {
      "settings": true,
      "sandboxIframe": true
    }
  },
  "contributes": {
    "ui": {
      "settings": [
        {
          "id": "dashboard",
          "label": "Dashboard",
          "icon": "gauge",
          "group": "My Plugin",
          "sandbox": true,
          "sandboxEntry": "ui/sandbox-settings.js"
        }
      ]
    }
  }
}
```

The iframe receives initial config and can read/write config via the postMessage bridge:

```ts
// Messages from host to sandbox iframe
type BridgeMessage =
  | { type: "plugin.init"; payload: { config: Record<string, unknown>; theme: string } }
  | { type: "host.action"; id: string; payload: unknown }

// Messages from sandbox iframe to host
type BridgeMessage =
  | { type: "plugin.ready" }
  | { type: "plugin.action"; id: string; payload: unknown }
  | { type: "plugin.resize"; payload: { width: number; height: number } }
  | { type: "plugin.toast"; payload: { message: string; variant?: string } }
  | { type: "plugin.error"; payload: { message: string; code?: string } }
```

The host does not forward `onConfigChange` calls through the bridge yet — the sandbox protocol is currently read-only for config. Use this tier when you need to display live data from an external source without granting host code execution.

**Permission requirement:** `permissions.ui.settings: true` + `permissions.ui.sandboxIframe: true`.

---

## Themes

Themes are **declarative only** (Tier 1). They provide CSS custom property overrides that change the appearance of the Synergy Web client.

### Theme JSON format

A theme is a JSON file conforming to `theme.schema.json`. Each theme must define `light` and `dark` color variants with seed colors:

```json
{
  "$schema": "https://raw.githubusercontent.com/ericsanchezok/synergy/main/packages/ui/src/theme/theme.schema.json",
  "name": "Midnight Ocean",
  "id": "midnight-ocean",
  "light": {
    "seeds": {
      "neutral": "#6B6B6B",
      "primary": "#3B82F6",
      "success": "#22C55E",
      "warning": "#F59E0B",
      "error": "#EF4444",
      "info": "#3B82F6",
      "interactive": "#3B82F6",
      "diffAdd": "#22C55E",
      "diffDelete": "#EF4444"
    },
    "overrides": {
      "background-base": "#FAFAFA",
      "surface-base": "#FFFFFF",
      "text-strong": "#030712"
    }
  },
  "dark": {
    "seeds": {
      "neutral": "#A0A0A0",
      "primary": "#60A5FA",
      "success": "#22C55E",
      "warning": "#F59E0B",
      "error": "#EF4444",
      "info": "#60A5FA",
      "interactive": "#60A5FA",
      "diffAdd": "#22C55E",
      "diffDelete": "#EF4444"
    },
    "overrides": {
      "background-base": "#0D1117",
      "surface-base": "#161B22",
      "text-strong": "#F0F6FC"
    }
  }
}
```

**Seed colors** — the minimum set of 9 colors used to generate the full palette (neutral scale, semantic colors, diff colors):

| Seed          | Purpose                                        |
| ------------- | ---------------------------------------------- |
| `neutral`     | Base gray scale for backgrounds, text, borders |
| `primary`     | Brand/accent color                             |
| `success`     | Positive state (green tones)                   |
| `warning`     | Cautionary state (yellow/orange tones)         |
| `error`       | Negative/critical state (red tones)            |
| `info`        | Informational state                            |
| `interactive` | Interactive elements (links, buttons, focus)   |
| `diffAdd`     | Diff addition highlights                       |
| `diffDelete`  | Diff deletion highlights                       |

**Overrides** — optional direct CSS custom property overrides (without the `--` prefix). Override any of the [~300 CSS custom properties](https://github.com/ericsanchezok/synergy/blob/main/packages/ui/src/theme/resolve.ts) used by the UI.

### Declaring a theme in plugin.json

```json
{
  "permissions": {
    "ui": {
      "themes": true
    }
  },
  "contributes": {
    "ui": {
      "themes": [
        {
          "id": "midnight-ocean",
          "label": "Midnight Ocean",
          "path": "themes/midnight-ocean.json"
        }
      ]
    }
  }
}
```

### How themes integrate with the UI

1. **Discovery:** On activation, the plugin's themes are registered in the `ThemeRegistry` with the scoped ID `{pluginId}:{themeId}`.
2. **Resolution:** The host's `ThemeProvider` calls `resolveThemeVariant()` which generates the full CSS variable map from the seed colors via OKLCH color space interpolation.
3. **Application:** Generated variables are injected into a `<style id="synergy-theme">` element in the document head as `:root { --var-name: value; ... }`.
4. **Activation:** `activateTheme(id)` sets the active theme ID. The `ThemeProvider` reads the active theme, resolves its light and dark variants, and applies the CSS.

> **Current limitation:** Plugin theme files at `path` are declared in the manifest schema but are not yet loaded by the activation lifecycle (`lifecycle.ts` registers themes with empty `variables: {}`). The theme resolution pipeline (`resolve.ts` / `themeToCss()`) is complete and ready — the missing piece is loading the theme JSON from the plugin bundle and passing it through the resolver. Plugin theme support will be fully functional once that loading step is wired.

---

## Icons

Icons are **declarative only** (Tier 1). Provide SVG files in your plugin bundle and reference them by the scoped name `{pluginId}:{iconName}`.

### Declaring icons in plugin.json

```json
{
  "permissions": {
    "ui": {
      "icons": true
    }
  },
  "contributes": {
    "ui": {
      "icons": [
        { "name": "logo", "path": "icons/logo.svg" },
        { "name": "service-on", "path": "icons/service-on.svg" },
        { "name": "service-off", "path": "icons/service-off.svg" }
      ]
    }
  }
}
```

### Naming convention

Icons are registered with the fully-qualified name `{pluginId}:{iconName}`. Use this qualified name when referencing the icon from other manifest fields:

```json
{
  "contributes": {
    "ui": {
      "settings": [
        {
          "id": "general",
          "icon": "my-plugin:logo",
          ...
        }
      ]
    }
  }
}
```

The host's `Icon` component resolves icons in this order:

1. Check the `icon-registry` for a matching registered icon with actual SVG content.
2. Fall back to the built-in Lucide icon component map.
3. If neither match, render nothing (empty placeholder).

### SVG sanitization policy

When registered, every SVG passes through `sanitizeSvg()` which enforces the following:

| Stripped element/attribute         | Reason                                              |
| ---------------------------------- | --------------------------------------------------- |
| `<script>` tags and content        | Prevents arbitrary script execution                 |
| `<foreignObject>` tags and content | Prevents embedded HTML/XML that may contain scripts |
| `on{event}=""` inline handlers     | Prevents inline JavaScript event handlers           |
| `javascript:` URI scheme           | Prevents `javascript:` in href/xlink:href           |

**Allowed:** `<svg>`, `<path>`, `<circle>`, `<rect>`, `<line>`, `<polyline>`, `<polygon>`, `<ellipse>`, `<g>`, `<defs>`, `<use>`, `<linearGradient>`, `<radialGradient>`, `<stop>`, `<mask>`, `<clipPath>`, standard presentation attributes (`fill`, `stroke`, `d`, etc.), and standard SVG viewBox settings.

> **Important:** Keep SVGs simple — no external references, no CSS imports, and no embedded data. The sanitizer only checks for the patterns listed above; malformed or nested content may be silently dropped.

> **Current limitation:** Icon SVG content at `path` is declared in the manifest schema but is not yet loaded by the activation lifecycle (`lifecycle.ts` registers icons with empty `svgContent: ""`). The `registerIcon()` function and sanitizer are ready — the missing piece is loading the SVG file from the plugin bundle. Plugin icon display will work once that loading step is wired.

---

## Permission reference

| Contribution              | Permission flag                | Required tier |
| ------------------------- | ------------------------------ | ------------- |
| Settings                  | `permissions.ui.settings`      | Any           |
| Custom settings (Tier 2)  | `permissions.ui.trustedImport` | Tier 2        |
| Sandbox settings (Tier 3) | `permissions.ui.sandboxIframe` | Tier 3        |
| Themes                    | `permissions.ui.themes`        | Any           |
| Icons                     | `permissions.ui.icons`         | Any           |

All UI contribution permissions default to `false`. Set them to `true` in `plugin.json` under `permissions.ui`.

---

## Complete examples

### Minimal: Declarative settings + icons

**`plugin.json`:**

```json
{
  "name": "hello-settings",
  "version": "1.0.0",
  "description": "A plugin with declarative settings",
  "permissions": {
    "ui": {
      "settings": true,
      "icons": true
    }
  },
  "contributes": {
    "ui": {
      "settings": [
        {
          "id": "greeting",
          "label": "Greeting",
          "icon": "message-square",
          "group": "Hello Plugin",
          "formSchema": {
            "type": "object",
            "properties": {
              "name": {
                "type": "string",
                "title": "Your Name",
                "default": "World"
              },
              "language": {
                "type": "string",
                "title": "Language",
                "enum": ["en", "es", "fr", "de"]
              }
            }
          }
        }
      ],
      "icons": [{ "name": "wave", "path": "icons/wave.svg" }]
    }
  }
}
```

### Custom component settings

**`plugin.json`:**

```json
{
  "name": "custom-settings",
  "version": "1.0.0",
  "description": "Plugin with a custom settings component",
  "permissions": {
    "ui": {
      "settings": true,
      "trustedImport": true
    }
  },
  "contributes": {
    "ui": {
      "entry": "ui/index.js",
      "settings": [
        {
          "id": "custom",
          "label": "Custom Settings",
          "icon": "cpu",
          "group": "My Plugin",
          "exportName": "MySettingsPanel"
        }
      ]
    }
  }
}
```

**`ui/MySettingsPanel.tsx`:**

```tsx
import { createSignal } from "solid-js"
import type { Component } from "solid-js"
import type { PluginSettingsPanelProps } from "@ericsanchezok/synergy-plugin"

export const MySettingsPanel: Component<PluginSettingsPanelProps> = (props) => {
  const [count, setCount] = createSignal((props.config.clickCount as number) ?? 0)

  return (
    <div>
      <p>Button clicked {count()} times</p>
      <button
        onClick={() => {
          const next = count() + 1
          setCount(next)
          props.onConfigChange({ ...props.config, clickCount: next })
        }}
      >
        Click me
      </button>
    </div>
  )
}

export default MySettingsPanel
```

### Theme-only plugin

**`plugin.json`:**

```json
{
  "name": "retro-theme",
  "version": "1.0.0",
  "description": "A retro terminal-inspired theme for Synergy",
  "permissions": {
    "ui": {
      "themes": true
    }
  },
  "contributes": {
    "ui": {
      "themes": [
        {
          "id": "retro-term",
          "label": "Retro Terminal",
          "path": "themes/retro-term.json"
        }
      ]
    }
  }
}
```

**`themes/retro-term.json`:**

```json
{
  "$schema": "https://raw.githubusercontent.com/ericsanchezok/synergy/main/packages/ui/src/theme/theme.schema.json",
  "name": "Retro Terminal",
  "id": "retro-term",
  "light": {
    "seeds": {
      "neutral": "#8B7355",
      "primary": "#2E7D32",
      "success": "#388E3C",
      "warning": "#F57F17",
      "error": "#C62828",
      "info": "#1565C0",
      "interactive": "#2E7D32",
      "diffAdd": "#2E7D32",
      "diffDelete": "#C62828"
    },
    "overrides": {
      "background-base": "#F5F0E8",
      "surface-base": "#FAF5EE",
      "text-strong": "#3E2723"
    }
  },
  "dark": {
    "seeds": {
      "neutral": "#8B7355",
      "primary": "#66BB6A",
      "success": "#66BB6A",
      "warning": "#FFA726",
      "error": "#EF5350",
      "info": "#42A5F5",
      "interactive": "#66BB6A",
      "diffAdd": "#66BB6A",
      "diffDelete": "#EF5350"
    },
    "overrides": {
      "background-base": "#1B1B1B",
      "surface-base": "#2D2D2D",
      "text-strong": "#E0E0E0"
    }
  }
}
```
