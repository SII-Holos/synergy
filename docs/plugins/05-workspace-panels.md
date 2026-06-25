# Workspace And Global Panels

Panels are Web UI surfaces declared in `plugin.json`.

```jsonc
{
  "contributes": {
    "ui": {
      "entry": "./dist/ui/index.js",
      "workspacePanels": [
        {
          "id": "scope-panel",
          "label": "Scope Panel",
          "icon": "layout-panel-left",
          "exportName": "ScopePanel",
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

Panel components can import type helpers:

```tsx
import type { Component } from "solid-js"
import type { PluginPanelProps } from "@ericsanchezok/synergy-plugin/ui"

export const ScopePanel: Component<PluginPanelProps> = (props) => {
  return <section>{props.pluginId}</section>
}
```

If `sandbox: true` is set, the host records sandbox metadata and uses `/plugin/:pluginId/sandbox/:panelId` for iframe loading.
