---
name: add-tool
description: Add or modify a first-party Synergy tool, its Zod parameters, execution behavior, capability taxonomy, exposure, permission boundary, attachments, or Web tool-card registration. Use for packages/synergy/src/tool and the corresponding packages/ui registrations; use plugin docs for plugin-owned tools.
---

# Add a First-party Tool

## Define the Behavioral Contract

1. Confirm the capability belongs in a first-party tool rather than an existing tool action, MCP server, plugin, or domain API.
2. Read [Execution boundaries](../../../docs/architecture/execution-boundaries.md) and inspect the nearest tool, its taxonomy entry, resolver path, renderer, and tests.
3. Write the failing invariant test first. Cover the public result, permission/capability behavior, cancellation, and state change that matter to callers.

## Implement the Backend

1. Define the tool with the current `Tool.define(id, init, options?)` pattern in `packages/synergy/src/tool/`.
2. Use precise Zod parameters and descriptions. Return the established `{ title, metadata, output, attachments? }` shape.
3. Honor `ctx.abort`, use `ctx.ask()` for operation-specific permission requests, and route filesystem, shell, network, remote, or external-write work through existing boundaries.
4. Register the tool in `tool/registry.ts` using the local ordering and conditional-exposure pattern.
5. Add an exact `tool/taxonomy.ts` entry with the correct domain kind and `stateful` / `externalIO` traits. Verify enforcement classification when arguments change the operation, such as local versus remote execution.
6. Add persisted-state migrations in the owning domain when the tool changes stored data shape.
7. Bound subprocess output while reading it: stream records, cap individual records and retained bytes, drain stderr concurrently, honor cancellation, and terminate the child when the consumer has enough results. Never call `text()` on potentially unbounded output and truncate only afterward.

### Channel-owned delivery tools

When a tool prepares an interactive Channel artifact or another provider-owned message:

1. Keep the tool provider-neutral and side-effect free. Return a bounded structured intent in tool metadata instead of provider JSON or a direct provider call.
2. Expose the tool only in Channel sessions when its contract depends on Channel identity, reply anchors, or provider capabilities.
3. Let the Channel runtime own rendering, durable registration, provider delivery, retry/deduplication, and original-requester binding. Foreground and unattended paths must share the same durable delivery record.
4. Treat provider callback IDs and values as opaque metadata. Validate them against the durable registration and synthesize model-visible text only from trusted registered labels.
5. Route an accepted callback into a fresh user task through the normal session, tool, and permission pipeline; never invoke a model, command, or tool directly from the callback handler.
6. Test card-only delivery, foreground/background races, provider callback namespace compatibility, identity and expiry rejection, event deduplication, and failure after an external side effect becomes unknowable.

## Register the Web Presentation

Complete all five first-party registrations:

1. `packages/ui/src/components/icon.tsx` — tool icon registry
2. `packages/ui/src/components/message-part.tsx` — title, subtitle, arguments, and tool-card metadata
3. `packages/ui/src/components/tool-renders.tsx` — renderer group registration
4. `packages/synergy/src/tool/taxonomy.ts` — runtime semantic classification
5. `packages/ui/src/components/tool/classifier.ts` — fallback semantic category

A renderer may either be registered by the render-group loop or self-register with `ToolRegistry.register()` and be imported for its side effect from the render-group entry point. In both cases, keep the registration reachable from the standard tool-render bundle and cover it with a render test.

The tool icon registry is separate from the product semantic-token registry. Load `develop-frontend` and use semantic product icons for non-tool UI added around the feature. Preserve accessible pending, success, error, and attachment presentation.

## Tool Description Quality

1. Write the description as a contract for a non-deterministic agent. It must answer four questions: what the tool does, when to use it (direct triggers and indirect signals), what inputs it accepts (types, constraints, defaults, and format examples), and what it returns (success shape and error conditions).
2. Keep parameter names consistent across tools: use the same term for the same concept everywhere (for example, always `customer_id`, never `id` in one tool and `identifier` in another).
3. Make error outputs actionable for agent recovery: state what went wrong, which input was invalid, and how to correct it (expected format plus an example). A generic "failed" message is not acceptable.
4. Check the new tool against the consolidation principle: if a human cannot definitively say which tool to use for a given situation, the agent cannot either. Merge narrow overlapping tools unless independent invocation is required, and do not over-consolidate past roughly 8-10 parameters.

## Verify

From `packages/synergy`, run the narrow tool test first. Add taxonomy, permission, migration, and server/UI tests when those contracts changed. Then run from the root:

```bash
bun run typecheck
bun run quality:quick
```

Run `./script/generate.ts` when a server route or OpenAPI-visible schema changed, not merely because a model-callable tool schema changed.

Use an isolated development instance for an end-to-end model/tool call. Check the transcript, tool card, attachments, denial path, cancellation, and persisted state.

## Synchronize Documentation

Update product or architecture docs when the tool introduces a user-visible concept or durable boundary. Update `AGENTS.md` only for a reusable repository rule. Do not copy the tool registry into documentation.

## Handoff

Report the tool ID, registry/exposure, taxonomy and capabilities, UI registrations, denial/cancellation behavior, migrations, tests, and end-to-end result.
