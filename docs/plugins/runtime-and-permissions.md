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
  runtimeEndpoint?: RuntimeEndpointHostService
}
```

The context is request state; do not cache it as a current Scope. `runtime` is read-only provenance identity for the active generation. Runtime startup never receives a raw SDK client, server URL, access token, or Scope/Session identity.

For a plugin Tool invoked by an Agent, `actor.messageId` is the assistant message that owns the Tool call and `actor.userMessageId`, when present, is the source user message resolved by the host. Plugins should use these IDs for provenance instead of asking the Agent to copy message identifiers into Tool input.

External plugins use `process`. Trusted built-ins may use `inProcess`. The process boundary isolates crashes, timeouts, and cleanup; it is not an OS security sandbox and does not claim to restrict direct filesystem or network access by plugin code.

External runtime generations are sampled by the host memory monitor. `pluginRuntimePolicy.limits.maxMemoryMb` sets the per-generation RSS limit and `memorySampleIntervalMs` sets the polling interval. A limit breach stops and restarts only the exact active registry generation, preserving its manifest and runtime limits, and records the measured recycle effect. A stale callback from a draining generation cannot stop or replace the current generation. Trusted `inProcess` plugins remain part of Control Plane memory and are not double-counted as external plugin processes.

Runtime timeouts are host-configurable through `pluginRuntimePolicy.limits`. Process-owned limits — startup timeout, heartbeat interval, host-service request timeout, memory limits, and shutdown grace — are captured when the plugin runtime starts and apply for that runtime's lifetime (including memory-recycle restarts). Invocation-level timeouts resolve in the invoking Scope on each call: `agentCallMaxRuntimeMs` hard-caps a plugin `agent.call`/`agent.start` model invocation (a plugin-declared larger timeout is clamped); `hookTimeoutMs` bounds one hook handler invocation; `contributionInvokeTimeoutMs` is the fallback for a contribution invocation without a declared `timeoutMs`; `shellRunTimeoutMs` is the fallback for a plugin `shell.run` command that omits `timeoutMs`; and `taskRunWaitTimeoutMs` bounds how long a plugin `task.run` waits for a delegated task to reach a terminal state, clamping the wait independently of the task's own execution timeout. All default to `120000` ms; plugin-declared timeouts win for the four fallback keys. Because invocation-level limits are read per call, a `50-plugins.jsonc` change takes effect on the next plugin call; process-owned limits take effect on the next plugin runtime start or reload.

## Runtime Logs

Every `PluginLogger` method accepts a message and optional `details: Record<string, unknown>`. Synergy preserves those structured details for both process and trusted `inProcess` runtimes, including error fields such as `code` and `reason`. The complete log entry, including `details`, counts toward the log rate limit's byte budget.

## Capabilities and Host Services

Capabilities describe Synergy services the host may inject. A contribution's `requires` must be a subset of the definition's top-level capability list.

| Capability              | Context service or action                                                           |
| ----------------------- | ----------------------------------------------------------------------------------- |
| `session.read`          | `context.session.get()`                                                             |
| `session.control`       | `context.session.abort()`                                                           |
| `workspace.read`        | `context.workspace.read()` and `metadata()`                                         |
| `workspace.write`       | `context.workspace.write()`                                                         |
| `task.delegate`         | `context.task.start()`, `run()`, `current()`, `get()`, and `cancel()`               |
| `asset.write`           | `context.asset.create()`                                                            |
| `shell.execute`         | `context.shell.run()` with an argv-only command                                     |
| `settings.read`         | `context.settings.get()`                                                            |
| `settings.write`        | `context.settings.replace()`                                                        |
| `secrets`               | plugin-scoped credential get/set/delete                                             |
| `tool.invoke`           | `context.tools.invoke()`                                                            |
| `ui.hostActions`        | trusted UI host navigation, panel, resource, notification, and confirmation actions |
| `composer.read`         | active Composer snapshots and settled-draft subscription                            |
| `composer.write`        | Composer completion, decoration, and revision-checked edits                         |
| `composer.intercept`    | serial normal-message preflight hooks                                               |
| `selection.read`        | settled non-sensitive selected text and text-action input                           |
| `agent.call`            | bounded Sessionless calls to owned or explicitly allowed Agents                     |
| `runtime.endpoint.read` | `context.runtimeEndpoint.get()`                                                     |

`runtime.endpoint.read` returns only `{ url, generation }` for the current loopback HTTP listener. The URL has no credentials, token, path, query, or fragment. The Host Service accepts no arguments, requires the capability both at plugin and contribution level, and is not exposed through the HTTP SDK. Loopback binds (`127.0.0.1`, `localhost`, `::1`) and wildcard binds (`0.0.0.0`, `::`) are both served over loopback and return a normalized `http://127.0.0.1:<port>` URL; a bind that excludes loopback (a concrete external address) makes the service unavailable with `PLUGIN_RUNTIME_ENDPOINT_UNSAFE`. It is a generic bridge for plugins that need to point an external local process at Synergy; Core does not manage that process or its configuration.

`task.delegate` may include `agents` and `maxRuntimeMs` constraints. Agent allowlists use public `agent.name` values, never Agent contribution IDs. `start()` launches native Cortex work and returns its handle immediately; `run()` waits for the same native Task to reach a terminal state and returns its `PluginTaskSnapshot`, including structured output when requested. Both paths resolve the target from Synergy's Agent registry and preserve plugin/generation/Scope ownership. A plugin's private `hidden` Agent is callable only by the same plugin ID and active generation. Non-owned targets retain ordinary Agent visibility rules.

`asset.create()` stores plugin-produced bytes through the host and returns the final host-owned attachment object for a tool result. Its `asset://` URL and `localPath` both identify the host's durable Asset copy; plugin-supplied paths and URLs are not accepted as attachment identity. `shell.run()` accepts only a non-empty argv array, passes through the normal permission and sandbox boundary, honors cancellation and timeout, and returns `stdout`, `stderr`, and `exitCode`.

Host capability approval and runtime permission evaluation are separate gates. Plugin approval always matches the original Host Service capability ID. Before a Tool reaches the control profile, the host maps only capabilities with an explicit runtime equivalent: `task.delegate` and the bounded `agent.call` map to `task`, `asset.write` maps to workspace `file_write`, `workspace.read` maps to `file_read`, `workspace.write` maps to `file_write`, and plugin-scoped `settings.read` maps to `config:read`. The low-risk read and bounded Agent mappings allow an approved Tool to run without prompting in `autonomous`; an unapproved original Host Service capability still fails closed. Unknown or unmapped Host Service capabilities remain conservative high-risk requests. A delegated Host call then validates `task.delegate` again before evaluating the concrete `task` permission. Host Service failures preserve a stable optional `code` across process IPC so plugins can make typed recovery decisions. `context.session.get()` and `context.session.abort()` are limited to Sessions in the invocation Scope. Cross-Scope targets fail with `PLUGIN_SESSION_SCOPE_MISMATCH`; delegated start parents use the separate `PLUGIN_TASK_PARENT_SCOPE_MISMATCH` code.

`context.agent.call()` and `context.agent.start()` are injected only for an executable contribution whose own `requires` includes the approved `agent.call` capability. Both resolve the target through Synergy's Agent registry and run with no tools, durable Session, Cortex task, or transcript. The host rechecks the invoking contribution, ownership or an `agents` allowlist, and hard runtime/input/output bounds; plugins cannot select an arbitrary provider or model.

An `agent.call` capability may declare a `modelRoles` allowlist using Synergy's public roles: `nano`, `mini`, `mid`, `thinking`, `long`, and `creative`. A call may request one allowed role through `modelRole`; otherwise the contributed Agent's manifest role is used. The host resolves both through the same configured role fallback chain. A concrete provider/model ID is never accepted. Approval shows the permitted role range, and an asynchronous call's idempotency digest includes its effective requested role.

`call()` waits for `{ text }` and is cancelled with its invocation. `start()` accepts an explicit `correlationId`, returns `{ callId }` after the host accepts the work, and continues under a host-owned `AbortController` after the initiating handler returns. A terminal `completed`, `error`, or `cancelled` result is delivered only to the same plugin ID, generation, and Scope through the `agent.call.after` observer. Active identical correlations are idempotent; changed content conflicts. Each plugin may own at most four active lightweight calls, with no waiting queue. Generation replacement, disable, uninstall, and runtime stop cancel the generation's active calls. Inputs, prompts, outputs, and terminal results are memory-only and are not written to the Session store or ordinary plugin logs.

Terminal delivery is exactly-once best effort. The host records a `plugin.agent-call` warning when directed delivery is rejected or acknowledged as `plugin_mismatch`, `no_handler`, or `failed`. Diagnostics are limited to plugin, generation, Scope, and call identity; terminal and delivery status; handler counts; and a stable error summary. They never include transient input or output, operation payloads, credentials, or provider responses. The call is settled and its capacity is released regardless; Core does not retry delivery or persist plugin business recovery state.

Disposing a project Scope disables new detached calls for that exact Scope, synchronously releases their admission capacity, aborts the providers, and then delivers one `cancelled` terminal before scoped plugin state is removed. Calls in other Scopes continue. A provider result that arrives after cancellation is ignored, and only a later explicit Scope activation permits new detached calls.

```ts
const { callId } = await context.agent!.start({
  agent: "metadata_agent",
  text: "Bounded transient input",
  correlationId: "correction:018f…",
  modelRole: "mini",
  timeoutMs: 12_000,
  maxOutputChars: 3_000,
})

hook({
  id: "metadata-complete",
  point: "agent.call.after",
  requires: ["agent.call"],
  async handler({ call }) {
    // Validate call.correlationId and call.text before a short durable write.
  },
})
```

Installation access is derived from capabilities, contribution `requires`, operation exposure, known constraints, and trusted UI. The grant is compared structurally on update: equal or narrower access continues without confirmation; added or broadened access asks once and shows only the difference. Unknown constraint changes are confirmed conservatively without assigning a plugin risk rating. Approval never expands the source declaration and never bypasses the ordinary runtime permission/sandbox decision.

`chat.system.transform` is the stable API4 system-context hook. The pre-GA `experimental.chat.system.transform` spelling remains accepted for existing early API4 artifacts, but new stable plugins must use the stable point. Other `experimental.*` hook points are not covered by the API4 compatibility promise.

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

`TIMEOUT` is reserved for the plugin runtime manager's own invocation deadline. An upstream abort remains `CANCELLED` even when its reason is a `TimeoutError`; the host forwards that abort to the active handler without treating the runtime as hung or stopping its generation.

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

Contribution health uses the API 4 identity `<kind>:<id>`. Operations, hooks, and tools may therefore reuse one plugin-local ID without overwriting each other's degraded state; bare IDs are not written.

`session.user-message.after` is a continuing observer dispatched asynchronously after an ordinary user message and all of its parts are persisted. Its input contains only `{ message: { id, text, createdAt } }`; Scope and Session identity come from `PluginInvocationContext`. It requires `session.read`, does not run for synthetic/internal messages, and cannot delay or roll back the Session loop.

`agent.call.after` is a directed observer, not a broadcast hook. It requires `agent.call` and receives only the terminal metadata for a call started by the same plugin generation in the same Scope. Delivery failure does not recreate or persist the transient Agent input.

`runtime.started` is a capability-gated observer delivered in the Home Scope after the listener and Global Runtime are ready. It runs only for contributions that require `runtime.endpoint.read`. Failure degrades only that contribution and does not block server startup. A newly installed plugin receives one catch-up delivery when the server is already running.

## Generation Changes and Lifecycle

A new generation starts and validates before it becomes active. The previous generation drains in-flight calls. A late response from an inactive generation is rejected.

Every external generation owns its memory-monitor handle. Startup failure, crash, drain, upgrade, uninstall, and ordinary shutdown all stop that handle before the registry entry is removed.

`lifecycle.install` runs once after a fresh installation transaction commits. Failure degrades the contribution but does not roll back the completed installation; the plugin should expose an explicit retry when the work is recoverable.

Install lifecycle delivery is host-process-aware. Inside a running Synergy server the handler runs immediately after the transaction commits and the outcome is recorded in the plugin lockfile (`completed` or `failed`). Outside a host process — for example `synergy plugin add` in a standalone CLI where no loopback listener exists — the lockfile entry is recorded as `pending`, the CLI reports that setup is queued, and the next host boot (or the next plugin runtime reload) delivers the pending lifecycle before the `runtime.started` broadcast. Updates never re-run `lifecycle.install` and preserve the recorded state. Failed installs are never retried automatically; `synergy plugin retry-install <id>` re-queues a failed or pending install (delivered by the host process at the next server start or plugin reload).

`lifecycle.upgrade` runs on the prepared new version before activation. Failure keeps the old version active. Plugin migrations must be idempotent because Synergy cannot roll back arbitrary plugin-owned data changes. Updates do not run `lifecycle.install`.

`lifecycle.uninstall` runs before registration, approval, settings, and runtime state are removed. Failure stops normal uninstall. Force uninstall skips the handler and may leave plugin-owned data.

Synergy does not delete or migrate plugin business data. The plugin owns its schema, location, concurrency, backup, upgrade, and cleanup policy.
