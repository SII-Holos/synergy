# Synergy Plugin SDK

`@ericsanchezok/synergy-plugin` is the authoring SDK for Synergy plugins.

Plugins extend the Synergy server runtime and can also contribute Web UI surfaces through `plugin.json`. The current API is intentionally strict: a plugin module exports an object descriptor with a canonical `id` and an `init()` method. The descriptor id, `plugin.json.name`, registry id, lockfile key, and approval key must all be the same canonical plugin id.

## Recommended Flow

```bash
synergy plugin create my-plugin --template tool-ui
cd my-plugin
bun install
synergy plugin validate --runtime-discovery
synergy plugin build
synergy plugin pack
synergy plugin sign my-plugin-0.1.0.synergy-plugin.tgz
synergy plugin publish my-plugin-0.1.0.synergy-plugin.tgz
```

During local development you can also install directly:

```bash
synergy plugin add file:///absolute/path/to/my-plugin
```

## Runtime Descriptor

Every runtime entry exports a `PluginDescriptor` object:

```ts
import type { PluginDescriptor } from "@ericsanchezok/synergy-plugin"
import { tool } from "@ericsanchezok/synergy-plugin/tool"

export const plugin: PluginDescriptor = {
  id: "my-plugin",
  name: "My Plugin",
  async init(input) {
    return {
      tool: {
        greet: tool({
          description: "Greet a user by name",
          args: {
            name: tool.schema.string(),
          },
          async execute(args, context) {
            return {
              output: `Hello, ${args.name}. Session: ${context.sessionID}`,
            }
          },
        }),
      },
      async "session.turn.after"(event) {
        console.log("turn completed", event.sessionID)
      },
    }
  },
}

export default plugin
```

There is no compatibility layer for legacy descriptor shapes. `plugin.json.name` must match `plugin.id`; Synergy fails validation or loading if they differ.

## Plugin Input

`init(input)` receives runtime services scoped to the active Synergy Scope:

```ts
type PluginInput = {
  client: ReturnType<typeof createSynergyClient>
  scope: unknown
  directory: string
  worktree: string
  serverUrl: URL
  $: BunShell
  pluginDir: string
  config: { get(): Promise<Record<string, unknown>>; set(values: Record<string, unknown>): Promise<void> }
  auth: { get(key: string): Promise<string | undefined>; set(key: string, value: string): Promise<void> }
  cache: { get<T>(key: string): Promise<T | undefined>; set(key: string, value: unknown, ttl?: number): Promise<void> }
}
```

For isolated worker/process plugins, these services are proxied through the host bridge and checked against the plugin approval record.

## Manifest

Each distributable plugin has a root `plugin.json`:

```jsonc
{
  "name": "my-plugin",
  "version": "0.1.0",
  "description": "Example Synergy plugin",
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
        "title": "Greet",
        "description": "Greet a user by name",
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

`contributes.ui.entry` is a runtime-loadable JavaScript asset. Source files such as `src/ui.tsx` are only build inputs. `synergy plugin build` uses the conventional UI source path and writes the compiled bundle to the declared entry.

## UI Types

UI contribution types are exported separately:

```ts
import type { PluginToolRendererProps, PluginPanelProps } from "@ericsanchezok/synergy-plugin/ui"
```

Supported UI surfaces are tool renderers, part renderers, workspace panels, global panels, settings sections, chat components, themes, icons, routes, and commands. The Web client loads aggregated UI metadata with the generated SDK method `plugin.listUiContributions()`, which maps to `/plugin/ui/contributions`; plugin JS and assets are still loaded through browser-native asset URLs.

## Runtime Modes

Synergy resolves each plugin to one runtime mode:

- `in-process` for trusted local or built-in plugins.
- `worker` for isolated plugins that do not need a separate OS process.
- `process` for third-party, high-risk, or policy-forced isolation.

Worker and process plugins are started through Synergy's plugin runner. The runner imports the descriptor, calls `init()`, reports tools and hooks to the host, and proxies tool and hook calls over the runtime protocol.

## Packaging

`synergy plugin build` writes a distributable `dist/` directory:

- `dist/plugin.json`
- `dist/runtime/index.js`
- `dist/ui/index.js` when UI entry is declared
- copied theme/icon/assets files
- `dist/permissions.summary.json`
- `dist/integrity.json`

`synergy plugin pack` archives `dist/` into `<name>-<version>.synergy-plugin.tgz`. `synergy plugin publish` accepts that tarball, stores the real artifact, records its `downloadUrl` and `sha256-...` integrity, and publishes registry metadata.

## Exports

```ts
import type { PluginDescriptor, PluginInput } from "@ericsanchezok/synergy-plugin"
import { tool } from "@ericsanchezok/synergy-plugin/tool"
import type { BunShell } from "@ericsanchezok/synergy-plugin/shell"
import type { PluginToolRendererProps } from "@ericsanchezok/synergy-plugin/ui"
```
