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

Plugin-wide permissions provide defaults. `data.config` can be `none`, `plugin`, or `global`; it defaults to `none`, so plugins that read Synergy plugin configuration must declare `plugin` or `global` explicitly. `contributes.tools[].capabilities` can narrow or override per-tool capability declarations. Synergy runtime, plugin-kit, and registry verification use the shared `@ericsanchezok/synergy-plugin/permissions` resolver for capability and permission-hash inputs.

## Runtime Capability Classes

At execution time Synergy registers plugin tools as `plugin__<pluginId>__<toolName>`. The plugin resolver converts manifest fields into the same Synergy capability classes used by built-in tools:

| Manifest field/value        | Synergy capability class      |
| --------------------------- | ----------------------------- |
| `tools.filesystem: "read"`  | `file_read`                   |
| `tools.filesystem: "write"` | `file_read`, `file_write`     |
| `tools.shell: true`         | `shell`                       |
| `tools.network: true`       | `network_request`             |
| `tools.localTools: true`    | `tool_invoke`                 |
| `tools.mcp: "invoke"`       | `mcp_invoke`                  |
| `tools.mcp: "spawn"`        | `mcp_invoke`, `mcp_spawn`     |
| `tools.task`                | `task`                        |
| `data.session: "read"`      | `session_data`                |
| `data.workspace: "read"`    | `workspace_data`              |
| `data.config: "plugin"`     | `config:read`                 |
| `data.config: "global"`     | `config:read`, `config:write` |
| `data.secrets: "own"`       | `secrets`                     |

Synergy does not add a coarse “plugin invoke” permission. Plugin tools are approved and profiled by the real Synergy capabilities they declare. Unknown plugin tools are treated as protected opaque operations and require user approval.

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

Worker/process plugins use a host bridge for config, secrets, cache, file, shell, network, session, workspace, delegated task, and tool invocation access. The bridge authorizes the corresponding Synergy capability class from the approved manifest. This keeps in-process and isolated plugins on the same permission path.
