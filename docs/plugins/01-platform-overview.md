# Synergy Plugin Platform v2

The Plugin Platform v2 is Synergy's comprehensive extension system. Plugins extend both the **runtime** (backend) and the **Web client** (frontend) through a unified manifest descriptor (`plugin.json`) and a TypeScript SDK (`@ericsanchezok/synergy-plugin`).

---

## What a plugin can do

**Runtime (server-side) contributions:**

- Custom tools registered via the `tool()` helper from `@ericsanchezok/synergy-plugin/tool`
- Lifecycle hooks around sessions, messages, agenda runs, notes, engram memory, tool execution, and permissions
- Custom agents and skills
- MCP server declarations (local or remote)
- CLI subcommands under `synergy <pluginId>`
- Config, auth, and cache stores scoped per plugin
- Auth provider integration (OAuth, API key)

**Web client (frontend) contributions:**

- Tool card renderers (custom UI for tool call results)
- Message part renderers
- Workspace panels (scope-aware side panels)
- Global panels (persistent across scopes)
- Settings panels
- Custom themes and icon packs
- Full-page routes
- UI commands

---

## Trust tiers

The platform defines three trust tiers that determine how a plugin's frontend code executes:

| Tier | Name                    | Execution model                                                                                                                                                                                                                         | Permission flag                |
| ---- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| 1    | **Declarative Native**  | No frontend code execution — all contributions are declared in `plugin.json`. Tools, agents, skills, and MCP run server-side only.                                                                                                      | (default)                      |
| 2    | **Trusted Host Import** | Frontend JS runs in the same origin as the Synergy Web client (`trustedImport: true`). Requires explicit opt-in in `permissions.ui`. Only available when the plugin is installed from a local path (`file://` or `.synergy/plugin/`).   | `permissions.ui.trustedImport` |
| 3    | **Sandboxed Iframe**    | Frontend JS runs in a sandboxed iframe with postMessage bridge (`sandboxIframe: true`). Panels use `sandboxEntry` to point at a compiled entry. Network and data access are controlled by `permissions.network` and `permissions.data`. | `permissions.ui.sandboxIframe` |

Tier 2 and Tier 3 are **not** available to plugins installed from npm or git registries — those are automatically categorized as "sandbox" by the runtime. Only locally-sourced plugins (Tier 2) can opt into trusted host import.

---

## Installation

Plugins can be installed from several sources:

| Source                   | Example spec                          | How                                                                                                                                                                                                             |
| ------------------------ | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **npm registry**         | `my-plugin` or `@scope/my-plugin`     | Listed in `synergy.jsonc` under `plugin`. Auto-installed on server start.                                                                                                                                       |
| **npm with version**     | `my-plugin@1.2.3`                     | Pinned version in config.                                                                                                                                                                                       |
| **GitHub**               | `github:owner/repo`                   | Resolved from the `github:` prefix.                                                                                                                                                                             |
| **Git URL**              | `git+ssh://git@github.com/owner/repo` | Any standard git protocol.                                                                                                                                                                                      |
| **File path**            | `file:///path/to/plugin`              | Local path resolved from the workspace root.                                                                                                                                                                    |
| **File path (relative)** | `file://./relative/path`              | Relative to the workspace directory.                                                                                                                                                                            |
| **Local directory**      | _(auto-discovered)_                   | `.synergy/plugin/` and `.synergy/plugins/` directories in the project scope or global config (`~/.synergy/config/plugin/` and `~/.synergy/config/plugins/`). All `*.ts` and `*.js` files are loaded as plugins. |

Use the CLI to manage plugins:

```bash
synergy plugin add <spec>        # install and activate
synergy plugin remove <id>       # uninstall and clean up
synergy plugin update [id]       # update to latest version
synergy plugin list              # list installed plugins
synergy plugin search <query>    # search npm registry
```

---

## Plugin manifest (`plugin.json`)

Every plugin ships a `plugin.json` in its root directory. Key fields:

```
Identity        name, version, description, author, homepage, license, icon, keywords
Compatibility   minSynergyVersion, engines.synergy, engines.bun
Dependencies    dependencies (map of plugin names to semver ranges)
Permissions     permissions.ui, permissions.network, permissions.data, permissions.tools
Contributions   contributes.tools, contributes.skills, contributes.agents,
                  contributes.mcp, contributes.commands, contributes.config,
                  contributes.extensionPack, contributes.ui
Lifecycle       main (entry point), lifecycle.install, lifecycle.uninstall, lifecycle.update
```

Full reference: [02-manifest-reference.md](02-manifest-reference.md) _(planned)_.

---

## Plugin SDK

The `@ericsanchezok/synergy-plugin` package provides types and helpers for authoring plugins:

```bash
bun add @ericsanchezok/synergy-plugin zod
```

```ts
import type { Plugin } from "@ericsanchezok/synergy-plugin"

const MyPlugin: Plugin = {
  id: "my-plugin",
  name: "My Plugin",
  async init(ctx) {
    return {
      tool: {
        /* ... */
      },
      "session.turn.after": async (input) => {
        /* ... */
      },
    }
  },
}
export default MyPlugin
```

SDK reference: [03-sdk-reference.md](03-sdk-reference.md) _(planned)_.

---

## Next steps

| Page                                                             | Audience                                          |
| ---------------------------------------------------------------- | ------------------------------------------------- |
| [06-settings-themes-icons.md](06-settings-themes-icons.md)       | Plugin authors adding settings, themes, and icons |
| [02-manifest-reference.md](02-manifest-reference.md)             | Plugin authors defining `plugin.json`             |
| [03-sdk-reference.md](03-sdk-reference.md)                       | Plugin authors writing runtime hooks and tools    |
| [04-tool-renderer-guide.md](04-tool-renderer-guide.md)           | Frontend developers building custom tool cards    |
| [04-ui-contributions.md](04-ui-contributions.md)                 | Frontend developers adding UI components          |
| [05-trust-and-permissions.md](05-trust-and-permissions.md)       | Operators reviewing plugin security               |
| [06-lifecycle-and-deployment.md](06-lifecycle-and-deployment.md) | Operators managing plugin installs and updates    |
