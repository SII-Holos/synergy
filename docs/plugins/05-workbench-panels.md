# Workbench Panels And Navigation

Plugin Web surfaces are declared under `contributes.ui` and enabled with `permissions.ui: true`.

```jsonc
{
  "contributes": {
    "ui": {
      "entry": "./dist/ui/index.js",
      "minUIApiVersion": "3.0",
      "workbenchPanels": [
        {
          "id": "scope-panel",
          "label": "Scope Panel",
          "icon": "layout-panel-left",
          "exportName": "ScopePanel",
          "surface": "side",
          "cardinality": "singleton",
          "requiresSession": true,
        },
      ],
      "navigation": [
        {
          "id": "dashboard",
          "label": "Dashboard",
          "icon": "layout-dashboard",
          "placement": "sidebar",
          "exportName": "DashboardPage",
          "order": 100,
        },
      ],
    },
  },
  "permissions": {
    "ui": true,
  },
}
```

The host prefixes plugin surface ids with the canonical plugin id at registration time, for example `my-plugin:scope-panel`.

Workbench panels are session surfaces. `surface` chooses `"side"` or `"bottom"`. `cardinality` chooses `"exclusive"`, `"singleton"`, or `"multi"`. `requiresSession` hides the panel until a concrete session exists.

Workbench panel components can import type helpers:

```tsx
import type { Component } from "solid-js"
import type { PluginWorkbenchPanelProps } from "@ericsanchezok/synergy-plugin/ui"

export const ScopePanel: Component<PluginWorkbenchPanelProps> = (props) => {
  return <section>{props.pluginId}</section>
}
```

Navigation entries are app-level destinations. `placement: "sidebar"` creates a top-level sidebar item and page route. `placement: "page"` creates the page route without adding a sidebar button. Both placements render at `/plugins/:pluginId/:navigationId`.

```tsx
import type { Component } from "solid-js"
import type { PluginNavigationProps } from "@ericsanchezok/synergy-plugin/ui"

export const DashboardPage: Component<PluginNavigationProps> = (props) => {
  return <section>{props.pluginId}</section>
}
```
