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

A plugin project should use the published plugin kit and plugin SDK. It should not depend on this monorepo checkout.

```bash
bunx @ericsanchezok/synergy-plugin-kit create my-plugin --template tool-ui
cd my-plugin
bun install
synergy-plugin dev
synergy-plugin validate --runtime-discovery
synergy-plugin publish-market
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

Use only the object descriptor API shown above. Export the descriptor object directly, and use `tool` as the runtime hook key for tool definitions.

The descriptor `id`, `plugin.json.name`, registry id, lockfile key, and approval id must be the same canonical plugin id.

## Manifest Rules

Each plugin has a root `plugin.json`:

```jsonc
{
  "name": "my-plugin",
  "version": "0.1.0",
  "description": "Example plugin",
  "engines": {
    "synergy": ">=2.4.3",
  },
  "main": "./src/index.ts",
  "permissions": {
    "tools": {
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
synergy-plugin validate --runtime-discovery
synergy-plugin build
synergy-plugin pack
```

For distribution:

```bash
synergy-plugin publish-market
```

`pack` creates an installable `.synergy-plugin.tgz` from `dist/`. `publish-market` validates, builds, packs, signs, uploads release assets when possible, updates the official registry checkout, and prepares the marketplace PR. For local marketplace UX testing, `synergy plugin publish <tarball>` still publishes to the local development registry.

For manual public Plugin Marketplace entry generation:

```bash
synergy-plugin entry my-plugin-0.1.0.synergy-plugin.tgz \
  --repo https://github.com/owner/my-plugin \
  --write-entry ../synergy-plugins/plugins/my-plugin.json
```

Open a PR against `SII-Holos/synergy-plugins`; merging to `main` makes the plugin visible in the Official marketplace source.

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
