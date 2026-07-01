# Workbench And Global Panels

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
      "globalPanels": [
        {
          "id": "global-panel",
          "label": "Global Panel",
          "icon": "globe",
          "exportName": "GlobalPanel",
        },
      ],
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

Global panels use `PluginPanelProps` and remain separate from session workbench surfaces.

If `sandbox: true` is set, the host records sandbox metadata and uses `/plugin/:pluginId/sandbox/:panelId` for iframe loading.
