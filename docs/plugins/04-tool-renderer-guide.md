# Tool Renderer Guide

Runtime tools are registered by `init()` under `tool`. UI renderers are declared in `plugin.json` under `contributes.ui.toolRenderers`.

## Runtime Tool

```ts
import type { PluginDescriptor } from "@ericsanchezok/synergy-plugin"
import { tool } from "@ericsanchezok/synergy-plugin/tool"

const plugin: PluginDescriptor = {
  id: "weather-plugin",
  async init() {
    return {
      tool: {
        getWeather: tool({
          description: "Get weather",
          args: {
            city: tool.schema.string(),
          },
          async execute(args) {
            return { output: `Weather for ${args.city}` }
          },
        }),
      },
    }
  },
}

export default plugin
```

## Manifest

```jsonc
{
  "name": "weather-plugin",
  "version": "0.1.0",
  "description": "Weather plugin",
  "contributes": {
    "tools": [
      {
        "name": "getWeather",
        "description": "Get weather",
        "capabilities": { "network": true, "filesystem": "none", "shell": false },
      },
    ],
    "ui": {
      "entry": "./dist/ui/index.js",
      "toolRenderers": [
        {
          "tool": "getWeather",
          "exportName": "default",
          "fallback": {
            "icon": "cloud-sun",
            "title": "Weather",
          },
        },
      ],
    },
  },
}
```

The manifest uses the short tool name. The Web host registers the renderer for the full runtime id `plugin__weather-plugin__getWeather`.

## UI Component

```tsx
import type { Component } from "solid-js"
import type { PluginToolRendererProps } from "@ericsanchezok/synergy-plugin/ui"

const WeatherRenderer: Component<PluginToolRendererProps> = (props) => {
  return <div>{props.output}</div>
}

export default WeatherRenderer
```

Build compiles `src/ui.tsx` to `dist/ui/index.js` when `contributes.ui.entry` is declared.

## Loading

The Web client fetches metadata through generated SDK method `plugin.listUiContributions()`. Trusted UI bundles are loaded from `/plugin/assets/:pluginId/:version/*`.
