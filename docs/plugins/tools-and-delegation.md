# Plugin Tools and Delegation

## Declare a Tool

```ts
import z from "zod"
import { capability, definePlugin, tool } from "@ericsanchezok/synergy-plugin"

export default definePlugin({
  id: "analysis-tools",
  version: "1.0.0",
  description: "Analysis tools",
  capabilities: [capability("task.run", { agents: ["explore"], maxRuntimeMs: 300_000 })],
  contributions: [
    tool({
      id: "analyze",
      description: "Analyze a research question",
      input: z.object({ question: z.string() }),
      requires: ["task.run"],
      async handler({ question }, context) {
        const task = await context.task!.run({
          subagent: "explore",
          description: "Analyze the question",
          prompt: question,
          visibility: "visible",
        })
        return { output: JSON.stringify(task) }
      },
    }),
  ],
})
```

Tool IDs are plugin-local. Synergy exposes them as namespaced host tools and validates input from the generated schema. `requires` drives the tool's capability gate and must reference top-level capabilities.

## Exposure and Display

`exposure` controls how the tool appears to agents: resident, grouped, searchable, or internal. `display` supplies host-owned presentation metadata. Both are declarations copied into the generated manifest; the executable handler remains in the runtime bundle.

A handler may return a string or `ToolResult` with `title`, `output`, metadata, and attachments. Keep durable data and provenance in plugin-owned artifacts; do not put runtime-generated IDs or secrets into display metadata.

## Delegated Tasks

`context.task` exists only when `task.run` is approved. The capability can constrain allowed subagents and maximum runtime. The host also checks agent visibility, control profile, permission policy, cancellation, and the outer invocation timeout.

Delegated tasks use Synergy's Cortex/session path and return a task ID, child Session ID, status, output, and optional error. Each call creates normal inspectable Synergy task state; plugins should not build a parallel anonymous task channel.

`task.run` is available only for handlers invoked by an agent tool call. UI and SDK operations do not have the parent agent/session/message identity required for delegation.

## Invoking Other Tools

`context.tools` exists only with `tool.invoke` approval and only in an agent invocation. The target tool must be visible in the active agent/session tool pipeline, and its ordinary permission and execution boundaries still apply. A plugin capability is a ceiling, not a bypass.

## Agents, Skills, and MCP

`agent`, `skill`, and `mcp` contributions are declarative. They are registered through host adapters and do not create runtime handlers. Keep all IDs and paths plugin-scoped. MCP servers follow the ordinary Synergy MCP lifecycle and are re-registered when plugin contributions reload.

The `tools` map inside a delegated task is only a visibility toggle for that task. It is not a capability declaration and must not be used to redefine host permissions.
