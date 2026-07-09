# Solid UI Runtime Guide

Synergy plugin Web UI surfaces are Solid components loaded by the host from the plugin UI entry. Declare a UI entry whenever the plugin renders Solid surfaces such as navigation pages, settings components, workbench panels, message slots, composer slots, commands, part renderers, or tool renderers without a declarative fallback.

```jsonc
{
  "permissions": {
    "ui": true,
  },
  "contributes": {
    "ui": {
      "entry": "./dist/ui/index.js",
      "minUIApiVersion": "3.0",
      "workbenchPanels": [
        {
          "id": "panel",
          "label": "Panel",
          "icon": "layout-panel-left",
          "surface": "side",
          "cardinality": "singleton",
          "exportName": "Panel",
        },
      ],
    },
  },
}
```

Plugin UI code imports Solid normally:

```tsx
import type { Component } from "solid-js"
import { Show } from "solid-js"
import type { PluginWorkbenchPanelProps } from "@ericsanchezok/synergy-plugin/ui"

export const Panel: Component<PluginWorkbenchPanelProps> = (props) => {
  return <Show when={props.panelId}>{props.panelId}</Show>
}
```

The plugin kit keeps `solid-js`, `solid-js/web`, and `solid-js/store` external to the plugin bundle so the Web host can render every plugin surface with the same Solid runtime as first-party surfaces. Static JS, CSS, SVG, theme, icon, and asset files are served from:

```text
/plugin/assets/:pluginId/:version/*
```
