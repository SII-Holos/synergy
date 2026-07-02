# Workbench And App Panels

Panels are Web UI surfaces declared in `plugin.json`.

```jsonc
{
  "contributes": {
    "ui": {
      "entry": "./dist/ui/index.js",
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
      "appPanels": [
        {
          "id": "dashboard",
          "label": "Dashboard",
          "icon": "layout-dashboard",
          "exportName": "DashboardPanel",
          "order": 100,
        },
      ],
    },
  },
  "permissions": {
    "ui": {
      "workbenchPanels": true,
      "appPanels": true,
      "trustedImport": true,
    },
  },
}
```

The host prefixes panel ids with the canonical plugin id at registration time, for example `my-plugin:scope-panel`.

Workbench panels are session surfaces. `surface` chooses `"side"` or `"bottom"`. `cardinality` chooses `"exclusive"`,
`"singleton"`, or `"multi"`. `requiresSession` hides the panel until a concrete session exists.

Workbench panel components can import type helpers:

```tsx
import type { Component } from "solid-js"
import type { PluginWorkbenchPanelProps } from "@ericsanchezok/synergy-plugin/ui"

export const ScopePanel: Component<PluginWorkbenchPanelProps> = (props) => {
  return <section>{props.pluginId}</section>
}
```

App panels create top-level sidebar entries after Synergy's built-in Agenda, Library, and Plugins entries. Their fixed URL is `/plugins/panels/:pluginId/:panelId`; ordering is by `order` and then `label`.

```tsx
import type { Component } from "solid-js"
import type { PluginPanelProps } from "@ericsanchezok/synergy-plugin/ui"

export const DashboardPanel: Component<PluginPanelProps> = (props) => {
  return <section>{props.pluginId}</section>
}
```

If `sandbox: true` is set, declare `permissions.ui.sandboxIframe` and provide `sandboxEntry` or `contributes.ui.entry`. The host loads iframe surfaces from `/plugin/:pluginId/sandbox/:surface/:surfaceId`, where `surface` is `workbenchPanels` or `appPanels`.
