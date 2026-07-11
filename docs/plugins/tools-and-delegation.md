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

`context.task` exists only when `task.delegate` is approved. It exposes three finite Host calls:

```ts
const handle = await context.task.start(input)
const snapshot = await context.task.get(handle)
await context.task.cancel(handle)
```

`start()` returns the task and child Session identity immediately. It does not wait for agent completion. The input requires a plugin-owned `correlationId`; Cortex persists it with owner metadata containing plugin ID, generation, and Scope ID.

`get()` reads the live Cortex task when present and otherwise reconstructs the same public snapshot from durable child Session metadata. The snapshot contains owner, agent, resolved model, timestamps, timeout, output configuration, terminal output/error, and token/cache/cost usage when available. `cancel()` is idempotent for queued/running tasks and does nothing for terminal tasks. Plugins may only inspect or cancel tasks owned by the same plugin generation and Scope.

For durable workflows, contribute an observer to `cortex.task.after`. Its public, strongly typed payload is `{ task: PluginTaskSnapshot }`; persist domain progress using `task.owner.correlationId`, then schedule the next unit of work. Synergy invokes this hook only for the plugin that owns the Task. Do not keep a plugin request open for an entire background workflow and do not build an anonymous parallel task channel.

Synergy also emits generic `plugin.task.started`, `plugin.task.queued`, `plugin.task.running`, and terminal `plugin.task.*` observability records. They use the plugin correlation ID as the trace ID and include generation, Scope, Task, Session, resolved model, and duration. The child Session remains the source of truth for full Agent messages and tool traces; plugins should keep stable Task/Session references instead of copying Session history.

A non-agent handler may call `start()` only when it supplies an explicit parent Session/message in the active Scope. This supports hook-driven continuations and trusted plugin UI commands using a previously bound control Session. Agent tool handlers may omit `parent`; the current invocation supplies it.

The capability can constrain allowed subagents and maximum runtime. The host also checks agent visibility, control profile, permission policy, Scope ownership, cancellation, and task ownership.

## Exposure and Display

`exposure` controls how a tool appears to agents: resident, grouped, searchable, or internal. `display` supplies host-owned presentation metadata. Both are declarations copied into the generated manifest; the executable handler remains in the runtime bundle.

A handler may return a string or `ToolResult` with title, output, metadata, and attachments. Keep durable business state and provenance in plugin-owned artifacts.

## Invoking Other Tools

`context.tools` exists only with `tool.invoke` approval and only in an agent invocation. The target tool must be visible in the active agent/session pipeline, and its ordinary permission boundaries still apply.

## Agents, Skills, and MCP

`agent`, `skill`, and `mcp` contributions are declarative. The `tools` map inside a delegated task is a per-task visibility toggle, not a capability declaration.
