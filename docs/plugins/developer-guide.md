# Plugin Developer Guide

## 1. Create

```bash
bunx @ericsanchezok/synergy-plugin-kit create my-plugin --template tool-ui
cd my-plugin
bun install
```

Available templates:

- `tool-ui`
- `workspace-panel`
- `api-connector`
- `theme-icon`

## 2. Edit The Descriptor

`src/index.ts` exports a descriptor object:

```ts
import type { PluginDescriptor } from "@ericsanchezok/synergy-plugin"
import { tool } from "@ericsanchezok/synergy-plugin/tool"

const plugin: PluginDescriptor = {
  id: "my-plugin",
  name: "My Plugin",
  async init(input) {
    return {
      tool: {
        greet: tool({
          description: "Greet a user",
          args: {
            name: tool.schema.string(),
          },
          async execute(args) {
            return { output: `Hello, ${args.name}` }
          },
        }),
      },
    }
  },
}

export default plugin
```

Do not change `plugin.id` without changing `plugin.json.name` to the same value.

## 3. Edit The Manifest

`plugin.json` declares identity, permissions, runtime tools, and UI contributions:

```jsonc
{
  "name": "my-plugin",
  "version": "0.1.0",
  "description": "Example plugin",
  "main": "./src/index.ts",
  "permissions": {
    "tools": {
      "invoke": true,
      "filesystem": "none",
      "network": false,
      "shell": false,
      "mcp": "none",
    },
  },
  "contributes": {
    "tools": [
      {
        "name": "greet",
        "description": "Greet a user",
        "capabilities": {
          "filesystem": "none",
          "network": false,
          "shell": false,
        },
      },
    ],
    "ui": {
      "entry": "./dist/ui/index.js",
      "toolRenderers": [{ "tool": "greet" }],
    },
  },
}
```

## 4. Validate

```bash
synergy-plugin validate --runtime-discovery
```

Runtime discovery imports the descriptor, calls `init()`, and checks that returned runtime tools match `contributes.tools`.

## 5. Build And Pack

```bash
synergy-plugin build
synergy-plugin pack
```

Build creates:

```text
dist/plugin.json
dist/runtime/index.js
dist/ui/index.js
dist/permissions.summary.json
dist/integrity.json
```

Pack creates:

```text
my-plugin-0.1.0.synergy-plugin.tgz
```

## 6. Sign And Publish

```bash
synergy-plugin sign my-plugin-0.1.0.synergy-plugin.tgz
synergy-plugin publish-market
```

`publish-market` prepares the official marketplace PR. For local marketplace UX testing, `synergy plugin publish <tarball>` records the real tarball artifact, `downloadUrl`, integrity, permission summary, and registry metadata in the local development registry.

## 7. Install Locally

```bash
synergy plugin add file:///absolute/path/to/my-plugin
synergy plugin add file:///absolute/path/to/my-plugin/src/index.ts
synergy plugin add file:///absolute/path/to/my-plugin-0.1.0.synergy-plugin.tgz
```

All local, npm, git, URL, directory, file, and tarball specs use the shared resolver.

## Runtime Notes

- In-process plugins execute tools directly.
- Worker/process plugins register proxy tools in the host and execute through the plugin runner.
- `Plugin.trigger()` proxies isolated hooks through the runtime supervisor.
- Bridge requests are checked against manifest-derived approval capabilities.

## Web UI Notes

Use `@ericsanchezok/synergy-plugin/ui` for UI prop types:

```ts
import type { PluginToolRendererProps, PluginPanelProps } from "@ericsanchezok/synergy-plugin/ui"
```

The Web client registers tool renderers, part renderers, workspace panels, global panels, settings, chat components, themes, icons, routes, and commands from `contributes.ui`.

The internal API call is generated SDK method `plugin.listUiContributions()`. Plugin bundles and assets load from `/plugin/assets/:pluginId/:version/*`.
