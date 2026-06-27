# Plugin Permissions And Consent

Plugin consent is keyed by canonical plugin id. The same id must be used in:

- `PluginDescriptor.id`
- `plugin.json.name`
- registry entry id
- lockfile id
- approval record id

Installation and validation fail when `plugin.json.name` and descriptor `id` differ.

## Capability Sources

Capabilities come from `plugin.json`:

```jsonc
{
  "permissions": {
    "tools": {
      "invoke": true,
      "filesystem": "read",
      "network": true,
      "shell": false,
      "mcp": "none",
      "task": {
        "agents": ["my-plugin-planner"],
        "maxRuntimeMs": 30000,
      },
    },
    "data": {
      "session": "metadata",
      "workspace": "read",
      "config": "plugin",
      "secrets": "own",
    },
  },
  "contributes": {
    "tools": [
      {
        "name": "search",
        "description": "Search an API",
        "capabilities": {
          "network": true,
          "filesystem": "none",
          "shell": false,
        },
      },
    ],
  },
}
```

Plugin-wide permissions provide defaults. `data.config` can be `none`, `plugin`, or `global`; use `none` for plugins that do not read configuration. `contributes.tools[].capabilities` can narrow or override per-tool capability declarations.

## Gate Mapping

At execution time Synergy registers plugin tools as `plugin__<pluginId>__<toolName>`. The enforcement gate decomposes manifest capabilities into gate capabilities:

| Manifest capability | Gate capability         |
| ------------------- | ----------------------- |
| `plugin_invoke`     | `plugin_invoke`         |
| `filesystem:read`   | `plugin_file_read`      |
| `filesystem:write`  | `plugin_file_write`     |
| `shell`             | `plugin_shell`          |
| `network`           | `plugin_network`        |
| `session_data`      | `plugin_session_read`   |
| `workspace_data`    | `plugin_workspace_read` |
| `config:read`       | `plugin_config_read`    |
| `config:write`      | `plugin_config_write`   |
| `secrets`           | `plugin_secret_read`    |
| `task`              | `task`                  |

Unknown or undeclared plugin tools remain opaque and require user approval.

`permissions.tools.task` gates plugin calls to `context.task.run()`. Use an explicit `agents` allowlist and
`maxRuntimeMs` for marketplace plugins. Hidden delegated tasks use Synergy's Cortex/session audit path and stay
out of the ordinary chat step list.

## Approval Records

Approval records store:

- canonical plugin id
- source (`local`, `npm`, `git`, `url`, `official`)
- version
- manifest hash
- permissions hash
- approved manifest capability strings
- approved UI surfaces
- risk

If the manifest or permissions hash changes, the approval expires and Synergy asks again.

## Install Consent

`synergy plugin add <spec>` resolves the spec, reads `plugin.json`, verifies the descriptor id, computes capabilities, and checks the approval store. Missing approval for medium/high risk plugins blocks install and returns an approval-required response.

Registry installs follow the same path and never pass a hidden consent bypass flag.

## Runtime Bridge Consent

Worker/process plugins use a host bridge for config, secrets, cache, file, shell, network, session, and workspace access. The bridge checks the same approved manifest capabilities. This avoids split semantics such as approving `filesystem:read` in the manifest while requiring a separate bridge-only name.
