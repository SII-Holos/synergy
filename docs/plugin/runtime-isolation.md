# Plugin Runtime Isolation

**Audience:** Plugin developers, operators
**Source of truth:** `packages/synergy/src/plugin-runtime/mode-resolver.ts`, `packages/synergy/src/plugin-runtime/supervisor.ts`

---

## Isolation modes

Synergy runs plugins in one of three modes, determined by the `resolveRuntimeMode()` function.

| Mode         | Name          | Mechanism                                | Use case                                                                |
| ------------ | ------------- | ---------------------------------------- | ----------------------------------------------------------------------- |
| `in-process` | In-process    | Same Bun process, same memory space      | Builtin, official, and local plugins with low risk                      |
| `worker`     | Worker thread | `Node.js Worker` (`node:worker_threads`) | User-trusted plugins that request isolation without OS process overhead |
| `process`    | OS process    | `Bun.spawn()` separate process           | Third-party plugins, high-risk plugins, any plugin forced by policy     |

## Default strategy

Rules are evaluated first-match:

1. `forceProcess` flag → `process`
2. Risk `"high"` → `process`
3. Manifest `"process"` → `process`
4. Manifest `"worker"` + `userTrusted` → `worker`
5. Manifest `"in-process"` + third-party source → forced to `process`
6. Default by source:
   - `builtin`, `official`, `local` → `in-process`
   - `npm`, `git`, `url` → `process`

Third-party plugins (npm, git, url) **never** run in-process. Worker mode is only granted to user-trusted plugins.

Source: `packages/synergy/src/plugin-runtime/mode-resolver.ts:54-82`.

## How to configure

Set `pluginRuntimePolicy` in `synergy.jsonc`:

```jsonc
{
  "pluginRuntimePolicy": {
    "thirdPartyDefaultMode": "process",
    "highRiskRequiresProcess": true,
    "allowThirdPartyInProcess": false,
    "allowWorkerMode": true,
    "allowLocalInProcess": true,
  },
}
```

| Field                      | Default     | Description                                      |
| -------------------------- | ----------- | ------------------------------------------------ |
| `thirdPartyDefaultMode`    | `"process"` | Default mode for npm/git/url plugins             |
| `highRiskRequiresProcess`  | `true`      | Always isolate high-risk plugins                 |
| `allowThirdPartyInProcess` | `false`     | Allow third-party plugins to request in-process  |
| `allowWorkerMode`          | `true`      | Allow plugins to request worker thread isolation |
| `allowLocalInProcess`      | `true`      | Allow local plugins to run in-process            |

Schema: `packages/synergy/src/config/schema.ts:1002-1032`.

## Dev mode testing

```bash
synergy plugin dev [path]
```

Starts a file watcher that re-validates the manifest and reloads plugin state on changes. Use `--sandbox-preview` to print sandbox iframe URLs for UI panels:

```bash
synergy plugin dev --sandbox-preview
```

The dev command prints the resolved runtime mode, health snapshot (PID, state, memory, heartbeat), and a log tail from the shared `PluginLogBuffer`.

Source: `packages/synergy/src/cli/cmd/plugin-dev.ts`.

## Migration plan

| Version      | Worker support                                           | In-process for third-party    |
| ------------ | -------------------------------------------------------- | ----------------------------- |
| v4.0         | Not supported                                            | Allowed                       |
| v4.1         | Supported (opt-in via manifest `runtime.mode: "worker"`) | Denied by default             |
| v5 (planned) | Default for user-trusted third-party                     | Fully removed for npm/git/url |

API route for runtime status: `GET /api/plugins/:pluginId/runtime/status`. See `plugin-runtime-routes.ts`.
