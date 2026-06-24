# Synergy Plugin Authoring For Agents

This is the shortest path for an external agent building a Synergy plugin. It is not a Synergy source contribution guide.

Do not read `AGENTS.md` unless the task is to modify Synergy itself.

## Required Context

Read these first:

- [development-kit.md](development-kit.md)
- [../../packages/plugin/README.md](../../packages/plugin/README.md)
- [02-manifest-reference.md](02-manifest-reference.md)
- [../plugin/toolchain.md](../plugin/toolchain.md)

Use these when relevant:

- [../plugin/runtime-isolation.md](../plugin/runtime-isolation.md)
- [../plugin/permissions-consent.md](../plugin/permissions-consent.md)
- [04-tool-renderer-guide.md](04-tool-renderer-guide.md)
- [05-workspace-panels.md](05-workspace-panels.md)
- [06-settings-themes-icons.md](06-settings-themes-icons.md)
- [09-security-best-practices.md](09-security-best-practices.md)

## Development Kit

A plugin project should use the installed Synergy CLI and the published plugin SDK. It should not depend on this monorepo checkout.

```bash
synergy plugin create my-plugin --template tool-ui
cd my-plugin
bun install
synergy plugin validate --runtime-discovery
synergy plugin build
synergy plugin pack
```

Install a local development plugin with:

```bash
synergy plugin add file:///absolute/path/to/my-plugin
```

## Descriptor Contract

Use only the object descriptor API:

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

Do not use:

- `definePlugin`
- function-style descriptors
- default-exported plugin factory functions
- `tools` as the runtime hook key; use `tool`

The descriptor `id`, `plugin.json.name`, registry id, lockfile key, and approval id must be the same canonical plugin id.

## Manifest Rules

Each plugin has a root `plugin.json`:

```jsonc
{
  "name": "my-plugin",
  "version": "0.1.0",
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

`contributes.ui.entry` is a built JavaScript asset. Source files such as `src/ui.tsx` are build inputs.

## Validation And Packaging

Always run runtime discovery before build or pack:

```bash
synergy plugin validate --runtime-discovery
synergy plugin build
synergy plugin pack
```

For distribution:

```bash
synergy plugin sign my-plugin-0.1.0.synergy-plugin.tgz
synergy plugin publish my-plugin-0.1.0.synergy-plugin.tgz
```

`pack` creates an installable `.synergy-plugin.tgz` from `dist/`. `publish` stores the real tarball, download URL, integrity, permission summary, and registry metadata.

## Runtime And Permission Model

- Trusted local plugins may run `in-process`.
- Isolated plugins run through the plugin runner in `worker` or `process` mode.
- Worker/process tools are registered as host proxy tools and execute through the runtime protocol.
- Bridge access for config, secrets, cache, file, shell, network, session, and workspace is checked against manifest-derived approval capabilities.

## UI Contributions

Use `@ericsanchezok/synergy-plugin/ui` for UI prop types.

Supported surfaces include:

- tool renderers
- part renderers
- workspace panels
- global panels
- settings sections
- chat components
- themes
- icons
- routes
- commands

Plugin JS and assets load through browser asset URLs. Internal Synergy API calls in the Web app use the generated SDK.

## When To Clone Synergy

Do not clone Synergy just to build a plugin. Clone this repository only if the task is to change or debug the platform itself: loader, runtime isolation, permission enforcement, marketplace, Web host registration, SDK generation, or plugin CLI implementation.
