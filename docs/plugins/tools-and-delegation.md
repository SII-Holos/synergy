# Plugin Tools and Delegation

## Declare a Tool

```ts
import z from "zod"
import { capability, definePlugin, tool } from "@ericsanchezok/synergy-plugin"

export default definePlugin({
  id: "analysis-tools",
  version: "1.0.0",
  description: "Analysis tools",
  capabilities: [capability("task.delegate", { agents: ["explore"], maxRuntimeMs: 300_000 })],
  contributions: [
    tool({
      id: "analyze",
      description: "Start analysis of a research question",
      input: z.object({ question: z.string(), correlationId: z.string() }),
      requires: ["task.delegate"],
      async handler({ question, correlationId }, context) {
        const handle = await context.task!.start({
          subagent: "explore",
          description: "Analyze the question",
          prompt: question,
          correlationId,
          visibility: "hidden",
        })
        return JSON.stringify(handle)
      },
    }),
  ],
})
```

Tool IDs are plugin-local. Synergy exposes them as namespaced host tools and validates input from the generated schema. `requires` drives the contribution capability gate and must reference top-level capabilities.

## Delegated Tasks

`context.task` exists only when `task.delegate` is approved. It exposes four finite Host calls:

```ts
const handle = await context.task.start(input)
const owner = await context.task.current()
const snapshot = await context.task.get(handle)
await context.task.cancel(handle)
```

`start()` returns the task and child Session identity immediately. It does not wait for agent completion. The input requires a plugin-owned `correlationId`; Cortex persists it with owner metadata containing plugin ID, generation, and Scope ID.

`current()` resolves the Task that owns the invocation's current child Session. It returns the same durable snapshot only when plugin ID, generation, and Scope all match; outside an owned plugin Task it returns `undefined`. This lets an internal plugin tool bind domain work from the Task's persisted `correlationId` without waiting for a post-launch Session attachment. `get()` reads the live Cortex task when present and otherwise reconstructs the same public snapshot from durable child Session metadata. The snapshot contains owner, agent, resolved model, timestamps, timeout, output configuration, terminal output/error, and token/cache/cost usage when available. `cancel()` is idempotent for queued/running tasks and does nothing for terminal tasks. Plugins may only inspect or cancel tasks owned by the same plugin generation and Scope.

For durable workflows, contribute an observer to `cortex.task.after`. Its public, strongly typed payload is `{ task: PluginTaskSnapshot }`; persist domain progress using `task.owner.correlationId`, then schedule the next unit of work. For BlueprintLoop completions, use `blueprint.after` with payload `{ loop: BlueprintLoopInfo }`. Synergy invokes each hook only for the plugin that owns the Task or BlueprintLoop. Do not keep a plugin request open for an entire background workflow and do not build an anonymous parallel task channel.
Synergy also emits generic `plugin.task.started`, `plugin.task.queued`, `plugin.task.running`, and terminal `plugin.task.*` observability records. They use the plugin correlation ID as the trace ID and include generation, Scope, Task, Session, resolved model, and duration. The child Session remains the source of truth for full Agent messages and tool traces; plugins should keep stable Task/Session references instead of copying Session history.

A non-agent handler may call `start()` only when it supplies an explicit parent Session/message in the active Scope. This supports hook-driven continuations and trusted plugin UI commands using a previously bound control Session. Agent tool handlers may omit `parent`; the current invocation supplies it.

The capability constrains allowed subagents and maximum runtime. Targets use Synergy's existing Agent registry and Cortex:

- A plugin-contributed Agent may be `hidden: true`. It stays out of every primary Agent prompt and cannot be selected through the native `task` tool. The owner plugin may start it through `context.task` only when the resolved Agent belongs to the same plugin ID and generation and the capability allowlist includes it.
- A target not contributed by the plugin follows ordinary Synergy delegation visibility. This permits an approved public Agent such as `explore`, but not a hidden built-in Agent or another plugin's private Agent.
- A contribution name collision or stale generation is rejected. The Host never falls through to a different registered Agent under the same name.

After target authorization, the normal control profile, permission policy, Scope ownership, cancellation, task ownership, Session loop, and Cortex lifecycle apply. A plugin must not implement a second Agent registry or task runner.

`task.delegate` and `task` are deliberately different contracts. `task.delegate` is the approved plugin Host Service capability recorded in the manifest. `task` is the runtime permission evaluated by the active Synergy control profile for one concrete delegation. The Host first validates `task.delegate`, then asks/evaluates `task`; it never looks for a manifest capability named `task`.

Plugin Host Service permission checks merge agent rules, persistent user rules, and Session rules. A user choice saved as an always/never rule therefore applies to later plugin Host Service calls under the same runtime permission, while an explicit deny continues to take precedence.

Parent Session failures use stable Host Service error codes: `PLUGIN_TASK_PARENT_REQUIRED` and `PLUGIN_TASK_PARENT_SCOPE_MISMATCH`. Error name, message, stack, and code survive process-runtime IPC so a plugin can distinguish rebinding from policy, workflow, or runtime failures instead of parsing text.

## Exposure and Display

`exposure` controls how a tool appears to agents: resident, grouped, searchable, or internal. `display` supplies host-owned presentation metadata. Both are declarations copied into the generated manifest; the executable handler remains in the runtime bundle.

A handler may return a string or `ToolResult` with title, output, metadata, and attachments. Keep durable business state and provenance in plugin-owned artifacts.

## Invoking Other Tools

`context.tools` exists only with `tool.invoke` approval and only in an agent invocation. The target tool must be visible in the active agent/session pipeline, and its ordinary permission boundaries still apply.

## Agents, Skills, and MCP

`agent`, `skill`, and `mcp` contributions are declarative. `hidden` controls prompt/native-task exposure, not whether the owning host workflow can invoke the Agent. The `tools` map inside a delegated task is a per-task visibility toggle, not a capability declaration.

## BlueprintLoop Delegation

`context.blueprint` exists only when `blueprint.delegate` is approved. It exposes three methods for creating and controlling BlueprintLoop workflows:

```ts
const loop = await context.blueprint.start({ plan: markdownPlan, digest: noteDigest, sessionID?, runMode?, model? })
const info = await context.blueprint.get(loopID)
const cancelled = await context.blueprint.cancel(loopID)
```

`start()` accepts a `BlueprintStartInput` with a Markdown `plan` body and a `digest` identifier; it creates a new BlueprintLoop bound to a new Note, starts execution, and returns the `BlueprintLoopInfo` snapshot. `get()` returns the current `BlueprintLoopInfo` snapshot with status, audit state, timestamps, and resolved model. `cancel()` stops a non-terminal loop; cancelling a terminal loop raises `LoopError.InvalidTransition`, so callers that need idempotent cleanup should inspect the current status first.

The `source` field in `BlueprintLoopInfo` is set to `"plugin"` when the loop was created by a plugin. The `pluginOwner` field records the creating plugin's ID, generation, Scope, and optional correlationId for durable workflow correlation.

Plugin-created loops follow the same execution lifecycle as user-created loops: agents, audit, cancellation, and all control profiles apply identically.

### Blueprint After Hook

Contribute a `blueprint.after` hook to react to BlueprintLoop completions:

```ts
import { capability, definePlugin, hook } from "@ericsanchezok/synergy-plugin"

export default definePlugin({
  id: "my-plugin",
  version: "1.0.0",
  capabilities: [capability("blueprint.delegate")],
  contributions: [
    hook({
      id: "on-blueprint-done",
      point: "blueprint.after",
      priority: 0,
      async handler(input, context) {
        // input.loop is BlueprintLoopInfo
        const loop = input.loop
        context.log.info("Blueprint complete", { id: loop.id, status: loop.status })
      },
    }),
  ],
})
```

The typed payload is `{ loop: BlueprintLoopInfo }`. Synergy invokes this hook only for the plugin that owns the BlueprintLoop. Hook priority controls invocation order among multiple hooks on the same point within a plugin.

## Light Loop

`context.lightloop` exists only when `lightloop.delegate` is approved. It exposes three methods:

```ts
const info = await context.lightloop.start({ sessionID?, taskDescription })
const current = await context.lightloop.get(sessionID)
await context.lightloop.cancel(sessionID)
```

`start()` activates the Light Loop workflow in an existing Session and returns a `LightLoopInfo` snapshot. The `taskDescription` feeds into the Light Loop's objective definition. When `sessionID` is omitted the current Session is used.

`get()` returns the current `LightLoopInfo` with status, sessionID, and taskDescription. `cancel()` disables the LightLoop workflow on the given Session.

### LightLoop After Hook

Contribute a `lightloop.after` hook to react to LightLoop completions:

```ts
import { capability, definePlugin, hook } from "@ericsanchezok/synergy-plugin"

export default definePlugin({
  id: "my-plugin",
  version: "1.0.0",
  capabilities: [capability("lightloop.delegate")],
  contributions: [
    hook({
      id: "on-lightloop-done",
      point: "lightloop.after",
      priority: 0,
      async handler(input, context) {
        // input.loop is LightLoopInfo
        const loop = input.loop
        context.log.info("LightLoop finished", { sessionID: loop.sessionID, status: loop.status })
      },
    }),
  ],
})
```

The typed payload is `{ loop: LightLoopInfo }`. Synergy invokes this hook only for the plugin that started the LightLoop.

## Session Control

Plugins with `session.control` capability can interact with Sessions beyond the current invocation scope. The capability gates `context.session.abort()` to terminate a Session by ID. For broader Session lifecycle actions — creating a parentless Primary Session, inspecting agent messages, compacting history, setting control profiles, or answering permission prompts — plugins declare a `tool` contribution with `requires: ["session.control"]` that calls the built-in `session_control` tool through `context.tools.invoke()`:

```ts
import { definePlugin, tool, capability } from "@ericsanchezok/synergy-plugin"
import z from "zod"

export default definePlugin({
  id: "session-manager",
  version: "1.0.0",
  capabilities: [capability("session.control")],
  contributions: [
    tool({
      id: "start-primary",
      description: "Create a parentless Primary Session in a given Scope",
      requires: ["session.control"],
      input: z.object({
        scopeID: z.string(),
        title: z.string().optional(),
        agent: z.string().optional(),
        initialMessage: z.string().optional(),
      }),
      async handler(input, context) {
        const result = await context.tools!.invoke("session_control", {
          action: "create",
          scopeID: input.scopeID,
          title: input.title,
          agent: input.agent,
          initialMessage: input.initialMessage,
        })
        return result.output
      },
    }),
  ],
})
```

The `session_control` tool supports actions: `create`, `abort`, `status`, `compact`, `set_agent`, `set_model`, `set_mode`, `set_control_profile`, `worktree_enter`, `worktree_leave`, `question_reply`, `question_reject`, and `permission_reply`. A `create` action with no parent produces a parentless Primary Session — the plugin's own Session hierarchy is separate from the new Session it creates. Plugin-originated sessions use the plugin's approved `session.control` capability for runtime permission evaluation.
