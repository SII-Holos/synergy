# Plugin Runtime and Capabilities

## Activation and Invocation

Synergy keeps one active runtime generation per plugin. The registry key is `pluginId + version + generation`; multiple enabled Scopes share it. A process starts lazily when an executable contribution is first invoked. `activate()` runs once for that generation and receives only plugin identity, version, generation, and a logger.

Every handler invocation receives a fresh context:

```ts
interface PluginInvocationContext {
  requestId: string
  scopeId: string
  sessionId?: string
  runtime: {
    hostVersion: string
    pluginVersion: string
    pluginGeneration: string
    protocolVersion: number
  }
  actor: PluginActor
  signal: AbortSignal
  log: PluginLogger
  events: ScopedPluginEventPublisher
  session?: SessionHostService
  task?: TaskHostService
  workspace?: WorkspaceHostService
  blueprint?: BlueprintHostService
  lightloop?: LightLoopHostService
  settings?: PluginSettingsService
  secrets?: PluginSecretsService
  tools?: PluginToolHostService
  agent?: PluginAgentHostService
  asset?: AssetHostService
  shell?: ShellHostService
}
```

The context is request state; do not cache it as a current Scope. `runtime` is read-only provenance identity for the active generation. Runtime startup never receives a raw SDK client, server URL, access token, or Scope/Session identity.

External plugins use `process`. Trusted built-ins may use `inProcess`. The process boundary isolates crashes, timeouts, and cleanup; it is not an OS security sandbox and does not claim to restrict direct filesystem or network access by plugin code.

External runtime generations are sampled by the host memory monitor. `pluginRuntimePolicy.limits.maxMemoryMb` sets the per-generation RSS limit and `memorySampleIntervalMs` sets the polling interval. A limit breach stops and restarts only the exact active registry generation, preserving its manifest and runtime limits, and records the measured recycle effect. A stale callback from a draining generation cannot stop or replace the current generation. Trusted `inProcess` plugins remain part of Control Plane memory and are not double-counted as external plugin processes.

## Capabilities and Host Services

Capabilities describe Synergy services the host may inject. A contribution's `requires` must be a subset of the definition's top-level capability list.

| Capability           | Context service or action                                                           |
| -------------------- | ----------------------------------------------------------------------------------- |
| `session.read`       | `context.session.get()`                                                             |
| `session.control`    | `context.session.abort()`                                                           |
| `workspace.read`     | `context.workspace.read()` and `metadata()`                                         |
| `workspace.write`    | `context.workspace.write()`                                                         |
| `task.delegate`      | `context.task.start()`, `run()`, `current()`, `get()`, and `cancel()`               |
| `asset.write`        | `context.asset.create()`                                                            |
| `shell.execute`      | `context.shell.run()` with an argv-only command                                     |
| `settings.read`      | `context.settings.get()`                                                            |
| `settings.write`     | `context.settings.replace()`                                                        |
| `secrets`            | plugin-scoped credential get/set/delete                                             |
| `tool.invoke`        | `context.tools.invoke()`                                                            |
| `ui.hostActions`     | trusted UI host navigation, panel, resource, notification, and confirmation actions |
| `composer.read`      | active Composer snapshots and settled-draft subscription                            |
| `composer.write`     | Composer completion, decoration, and revision-checked edits                         |
| `composer.intercept` | serial normal-message preflight hooks                                               |
| `selection.read`     | settled non-sensitive selected text and text-action input                           |
| `agent.call`         | bounded Sessionless calls to owned or explicitly allowed Agents                     |

`task.delegate` may include `agents` and `maxRuntimeMs` constraints. `start()` launches native Cortex work and returns its handle immediately; `run()` waits for the same native Task to reach a terminal state and returns its `PluginTaskSnapshot`, including structured output when requested. Both paths resolve the target from Synergy's Agent registry and preserve plugin/generation/Scope ownership. A plugin's private `hidden` Agent is callable only by the same plugin ID and active generation. Non-owned targets retain ordinary Agent visibility rules.

`asset.create()` stores plugin-produced bytes through the host and returns the final host-owned attachment object for a tool result. `shell.run()` accepts only a non-empty argv array, passes through the normal permission and sandbox boundary, honors cancellation and timeout, and returns `stdout`, `stderr`, and `exitCode`.

Host capability approval and runtime permission evaluation are separate gates. For delegated work, the manifest gate is `task.delegate`; the control-profile permission is `task`. Host Service failures preserve a stable optional `code` across process IPC so plugins can make typed recovery decisions.
`context.session.get()` and `context.session.abort()` are limited to Sessions in the invocation Scope. Cross-Scope targets fail with `PLUGIN_SESSION_SCOPE_MISMATCH`; delegated start parents use the separate `PLUGIN_TASK_PARENT_SCOPE_MISMATCH` code.

`context.agent.call()` is injected only for an executable contribution whose own `requires` includes the approved `agent.call` capability. It resolves the target through Synergy's Agent registry and uses the Agent's native model/model-role configuration. It always runs with no tools, durable Session, Cortex task, or transcript. The host rechecks the invoking contribution, ownership or an `agents` allowlist, and hard runtime/input/output bounds; plugins cannot select an arbitrary provider or model.

Approval is derived from generated capabilities and trusted UI. Changing the manifest or capability hash requires approval again. Approval never expands the source declaration.

## Operations

Operations are finite request/response handlers. `type` is `query` or `command`; both input and output are validated against generated JSON Schema. `expose` defaults to `['ui']`. Only operations that include `sdk` may be called through `client.plugin.invoke()`.

The server endpoint is:

```text
POST /plugin/:pluginId/operations/:operationId/invoke
```

The host checks plugin existence, Scope enablement, contribution identity, caller exposure, schemas, timeout, cancellation, and generation. Stable error codes are:

```text
PLUGIN_NOT_FOUND
PLUGIN_DISABLED
PLUGIN_UNAVAILABLE
CONTRIBUTION_NOT_FOUND
INPUT_INVALID
OUTPUT_INVALID
CAPABILITY_DENIED
CONFLICT
TIMEOUT
CANCELLED
RUNTIME_ERROR
```

Long-running domain work returns a plugin-owned handle and reports changes through declared events. Synergy does not create a generic plugin Job or business-data store.

## Events

Declare every publishable event with an ID and payload schema. `context.events.publish()` validates that declaration and payload, then attaches plugin ID/version, generation, Scope, optional Session, sequence, and timestamp. A plugin cannot publish as another plugin or Scope.

Events are for invalidation and small changes. Consumers should re-run a query for a complete snapshot. UI subscriptions are filtered by plugin ID, Scope, and event ID.

## Hooks

Plugins contribute handlers to host-defined hook points. A plugin cannot define execution semantics for a new point.

- `observer` observes and cannot replace the value.
- `transform` returns the next value in a serial chain.
- `guard` returns `{ allow, reason?, value? }`.

Ordering is priority, plugin ID, then contribution ID. Each hook point owns input/output schema, timeout, and failure policy. A handler failure degrades that contribution. It propagates only when the point's failure policy requires it; a guard denial always propagates as a denial.

`session.user-message.after` is a continuing observer dispatched asynchronously after an ordinary user message and all of its parts are persisted. Its input contains only `{ message: { id, text, createdAt } }`; Scope and Session identity come from `PluginInvocationContext`. It requires `session.read`, does not run for synthetic/internal messages, and cannot delay or roll back the Session loop.

## Generation Changes and Lifecycle

A new generation starts and validates before it becomes active. The previous generation drains in-flight calls. A late response from an inactive generation is rejected.

Every external generation owns its memory-monitor handle. Startup failure, crash, drain, upgrade, uninstall, and ordinary shutdown all stop that handle before the registry entry is removed.

`lifecycle.upgrade` runs on the prepared new version before activation. Failure keeps the old version active. Plugin migrations must be idempotent because Synergy cannot roll back arbitrary plugin-owned data changes.

`lifecycle.uninstall` runs before registration, approval, settings, and runtime state are removed. Failure stops normal uninstall. Force uninstall skips the handler and may leave plugin-owned data.

Synergy does not delete or migrate plugin business data. The plugin owns its schema, location, concurrency, backup, upgrade, and cleanup policy.
