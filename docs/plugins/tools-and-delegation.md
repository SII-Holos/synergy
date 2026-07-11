# Plugin Tools and Delegation

Plugin tools use the public `tool()` helper and participate in the same session, permission, sandbox, timeout, tracing, and result-presentation pipeline as first-party tools.

## Define and Declare the Same Tool

Runtime code defines behavior:

```ts
import { tool } from "@ericsanchezok/synergy-plugin/tool"

export const lookup = tool({
  description: "Look up a record",
  exposure: { mode: "search", keywords: ["record", "lookup"] },
  args: {
    id: tool.schema.string(),
  },
  async execute(args, context) {
    if (context.abort.aborted) throw new Error("Cancelled")
    return { output: `Record ${args.id}` }
  },
})
```

`plugin.json` declares the same tool's name, description, exposure, display contract, and capability ceiling. Runtime discovery rejects undeclared runtime tools and meaningful capability mismatches because the host must know what it is approving before code runs.

Use precise Zod arguments and return either a string or a `ToolResult` containing `output` plus optional title, metadata, and attachments.

## Exposure

Exposure controls how a tool enters model context:

- `resident` — directly available in the active tool set.
- `group` — available through a named expandable group.
- `search` — discoverable by tool search using its title and keywords.
- `internal` — unavailable to ordinary resident, group, and search discovery; reserved for an explicitly controlled flow.

Exposure is not permission. A discovered tool still passes through capability classification and the active control profile.

## Tool Context

The execution context identifies the session, message, agent, current directory, and abort signal. Optional services are present only when the host and manifest permit them:

- `ask()` requests a normal Synergy permission decision.
- `$` runs shell work through the active workspace boundary.
- `task.run()` delegates a child session through Cortex.
- `tools.invoke()` invokes another allowed tool through the host.

Honor `abort`; avoid detached work that survives cancellation or plugin shutdown.

## Attachments and Presentation

Use the generated SDK client or public asset API to upload content and return an `asset://` URL in an attachment. Do not import Synergy's private asset modules.

Each attachment can declare a renderer, size, crop mode, whether it is hidden, and how much content is provided to the model. A tool can also set:

```ts
metadata: {
  display: {
    toolCard: "hidden",
  },
}
```

This is appropriate when the returned attachment is the primary visible result. It does not remove the tool call from durable history.

For generated image, video, or audio, declare `display.kind: "media-generation"` both in runtime code and the manifest. The host then owns the pending media presentation. Accessibility labels such as `actionLabel` and `pendingTitle` describe the state; they are not a substitute for a useful textual result.

## Delegated Tasks

`context.task.run()` starts a durable Cortex child session. The plugin receives a task ID, child session ID, terminal status, and the requested output form:

- `summary` — a compact child-work summary
- `final_response` — the child's final response
- `structured` — JSON Schema-validated data, with up to three repair turns

```ts
const result = await context.task?.run({
  subagent: "my-plugin-planner",
  description: "Plan the lookup",
  prompt: "Return the lookup steps as JSON.",
  tools: {
    "*": false,
    "plugin__my-plugin__private_lookup": true,
  },
  visibility: "hidden",
  timeoutMs: 120_000,
  output: {
    mode: "structured",
    schema: {
      type: "object",
      required: ["steps"],
      properties: {
        steps: { type: "array", items: { type: "string" } },
      },
    },
    maxRepairTurns: 2,
  },
})
```

Declare `permissions.tools.task` before using this service. Marketplace plugins should bound both the allowed subagent names and `maxRuntimeMs`.

`visibility: "hidden"` removes child progress from the ordinary chat step list; it does not erase the child session, lineage, trace, or permission boundary. Use hidden visibility for internal orchestration, not for concealing consequential external actions.

## Internal Helpers

An internal helper is useful when a public tool delegates a tightly controlled child that needs a private operation. Declare the helper with `exposure: { mode: "internal" }` and pass an explicit tool allowlist to the child.

Do not use internal exposure as a security boundary by itself. The manifest capability ceiling, task permission, child control profile, and runtime enforcement are the actual boundary.

## Invoking Other Tools

`context.tools.invoke()` routes a nested invocation through Synergy rather than calling another plugin function directly. This preserves schemas, timeouts, result normalization, capability enforcement, and tracing.

Use a direct function call only for pure implementation helpers that are not independently modeled as tools. Use host invocation when the operation is a real tool capability or must remain auditable as one.

## Design Checklist

- Keep every tool's capability declaration narrower than or equal to the manifest ceiling.
- Choose exposure based on model-context cost and discoverability.
- Keep internal helpers out of broad tool catalogs.
- Return useful text even when a custom renderer or attachment owns the main presentation.
- Bound child agents, tools, time, and output schema.
- Propagate cancellation and avoid ambient filesystem, process, or network access.
- Test behavior through the public SDK contract, not private Synergy modules.
