# Plugin Runtime Isolation

Synergy can run a plugin in one of three modes:

| Mode         | Runtime                | Typical source                                   |
| ------------ | ---------------------- | ------------------------------------------------ |
| `in-process` | Synergy server process | trusted local and built-in plugins               |
| `worker`     | Bun/Node worker thread | trusted isolated plugins                         |
| `process`    | separate Bun process   | third-party, high-risk, or policy-forced plugins |

Runtime mode is resolved from plugin source, manifest policy, user trust, and risk. Third-party npm/git/url plugins do not run in-process unless policy explicitly allows it.

## Runner Contract

Isolated plugins do not execute their normal entrypoint as the host process. Synergy starts `plugin-runtime/runner.ts` in the worker/process and passes:

- `entryPath`
- plugin id
- plugin directory
- active Scope data
- server URL

The runner imports the plugin descriptor, verifies the descriptor id, calls `init()`, reports tools and hook names to the host, and then handles:

- `invokeTool`
- `triggerHook`
- `reload`
- `shutdown`
- `ping` / heartbeat

Tool calls and hook calls are proxied back to the isolated runtime through `PluginRuntimeSupervisor`.

## Bridge Enforcement

Worker/process plugins access host services through a bridge. Every bridge method maps to the same manifest capability semantics used by the permission gate:

| Bridge area               | Synergy capability class                 |
| ------------------------- | ---------------------------------------- |
| cache                     | none; scoped plugin cache only           |
| config read/write         | `config:read`, `config:write`            |
| secrets                   | `secrets`                                |
| workspace file read/write | `file_read`, `file_write`                |
| workspace shell           | `shell`                                  |
| network                   | `network_request`                        |
| session data              | `session_data`                           |
| workspace data            | `workspace_data`                         |
| delegated task            | `task`                                   |
| tool invocation           | target tool's Synergy capability classes |
| permission request        | requested Synergy permission/capability  |

Approval records store Synergy capability classes under the canonical plugin id. The bridge uses the same approved classes as in-process plugin tools.

Workspace file and shell bridge calls require an active plugin tool context. Plugin package assets should be read from `input.pluginDir` directly; they are not workspace permissions.

## Development Commands

```bash
synergy-plugin validate --runtime-discovery
synergy plugin dev
synergy plugin status <id>
```

Runtime status is exposed under plugin runtime routes, including `/api/plugins/:pluginId/runtime/status`.

## Hook Behavior

Hooks receive `(input, output)` where `output` is mutable. The isolated runner returns the mutated `output`; if a hook returns a replacement value, that value is used. This keeps worker/process hooks aligned with in-process plugin behavior while preserving the mutation-first convention.

Hook invocation failures are isolated per plugin. A thrown error or timeout disables the failing plugin and leaves the current output unchanged so the host can continue with built-in behavior. For `permission.ask`, this means Synergy continues to its normal permission prompt path; a failed plugin hook never turns an ask into an allow.
