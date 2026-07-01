# Plugin Platform Overview

Synergy plugins extend the server runtime and optionally the Web client. A plugin is defined by:

- `plugin.json` manifest
- a runtime entry exporting an object `PluginDescriptor`
- optional UI bundle/assets
- optional registry package tarball

Plugin runtime entries use object descriptors:

```ts
import type { PluginDescriptor } from "@ericsanchezok/synergy-plugin"

export const plugin: PluginDescriptor = {
  id: "my-plugin",
  async init(input) {
    return {}
  },
}

export default plugin
```

`plugin.id` and `plugin.json.name` must match. That value is the canonical plugin id used by the loader, lockfile, approval store, runtime supervisor, registry, and Web UI.

## Contributions

Runtime contributions:

- tools
- hooks
- CLI commands under `synergy <pluginId>`
- skills and agents
- provider auth
- MCP declarations
- config/auth/cache stores

Web contributions:

- tool renderers
- part renderers
- workbench panels
- global panels
- settings sections
- chat components
- themes
- icons
- routes
- commands

## Install Sources

All install/load paths use the shared plugin spec resolver:

| Source           | Example                                                       |
| ---------------- | ------------------------------------------------------------- |
| local directory  | `file:///Users/me/plugins/my-plugin`                          |
| local entry file | `file:///Users/me/plugins/my-plugin/src/index.ts`             |
| plugin tarball   | `file:///Users/me/plugins/my-plugin-0.1.0.synergy-plugin.tgz` |
| npm package      | `@scope/synergy-plugin-example`                               |
| git spec         | `github:owner/repo`                                           |
| URL/git URL      | `https://...` or `git+ssh://...`                              |

The resolver finds `plugin.json`, resolves the runtime entry, determines source type, and enforces canonical identity.

## Runtime Modes

| Mode         | Description                                    |
| ------------ | ---------------------------------------------- |
| `in-process` | Direct execution in the Synergy server process |
| `worker`     | Isolated worker running the plugin runner      |
| `process`    | Separate Bun process running the plugin runner |

Worker/process modes register proxy tools in the host. Tool execution and hook triggering go through the runtime supervisor.

## Web Loading

The Web client reads UI metadata through the generated SDK method `plugin.listUiContributions()`, backed by `/plugin/ui/contributions`. Component bundles and static assets are loaded through `/plugin/assets/:pluginId/:version/*`.

`contributes.ui.entry` must point to built JavaScript such as `./dist/ui/index.js`. Source files such as `src/ui.tsx` are build inputs only.

## Development Commands

```bash
bunx @ericsanchezok/synergy-plugin-kit create my-plugin
cd my-plugin
bun install
synergy-plugin validate --runtime-discovery
synergy-plugin publish-market
synergy plugin add file:///absolute/path/to/my-plugin
```
