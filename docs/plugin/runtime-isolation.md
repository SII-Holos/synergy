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

| Bridge area        | Manifest capability                   |
| ------------------ | ------------------------------------- |
| cache              | none; scoped plugin cache only        |
| config read/write  | `config:read`, `config:write`         |
| secrets            | `secrets`                             |
| file read/write    | `filesystem:read`, `filesystem:write` |
| shell              | `shell`                               |
| network            | `network`                             |
| session data       | `session_data`                        |
| workspace data     | `workspace_data`                      |
| tool invocation    | target tool capabilities              |
| permission request | requested Synergy permission          |

Approval records store manifest capability names under the canonical plugin id. The bridge accepts those manifest names and does not require callers to know gate-internal names such as `plugin_file_read`.

## Development Commands

```bash
synergy-plugin validate --runtime-discovery
synergy plugin dev --sandbox-preview
synergy plugin status <id>
```

Runtime status is exposed under plugin runtime routes, including `/api/plugins/:pluginId/runtime/status`.

## Hook Behavior

Hooks receive `(input, output)` where `output` is mutable. The isolated runner returns the mutated `output`; if a hook returns a replacement value, that value is used. This keeps worker/process hooks aligned with in-process plugin behavior while preserving the mutation-first convention.
