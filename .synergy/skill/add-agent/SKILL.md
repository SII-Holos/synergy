---
name: add-agent
description: Add or change a built-in Synergy primary agent, subagent, hidden reviewer, prompt, visibility rule, delegation group, model role, or permission profile. Use for requests about built-in agent definitions under packages/synergy/src/agent; do not use for user-configured, plugin, or external agents.
---

# Add a Built-in Agent

## Establish the Boundary

1. Confirm the request requires a repository-built agent. Route configurable agents to `60-agents.jsonc`, plugin agents to the plugin SDK, and external coding agents to `external-agent/`.
2. Read [Cortex](../../../docs/architecture/cortex.md), [Workflows](../../../docs/architecture/workflows.md), and [Execution boundaries](../../../docs/architecture/execution-boundaries.md) when delegation, review, or permissions are involved.
3. Inspect `agent.ts`, `builtin-context.ts`, the target `builtin-*.ts`, and two neighboring agent factories. Treat these files as authoritative; do not copy an old inventory from documentation.
4. Load `integrate-llm` when host code will invoke the agent for classification, extraction, generation, review, or delegated work. Decide explicitly whether the call is sessionless, continues an existing session, or launches a Cortex child.

## Implement

1. Choose the owning catalog:
   - primary orchestrator: `builtin-primary.ts`
   - classic subagent: `builtin-legacy-subagents.ts`
   - coding-harness subagent: a prompt factory registered in `builtin-max-subagents.ts`
   - hidden utility or model-only agent: `builtin-internal.ts`
2. Add or update the prompt under `agent/prompt/`. Match the nearest flat prompt or `base.txt` plus `builder.ts` pattern. Keep product policy in code/config contracts and keep the prompt focused on the agent's role and completion criteria.
3. Define the agent with the current `Agent.Info` or `createSubagent(ctx, definition)` contract. Select the narrowest existing `SubagentPermissionProfile`; add a new profile only when no current profile expresses the required capability boundary.
4. Keep tool exposure separate from authorization. Native task-callable subagents retain the common `search_tools` and `expand_tools` permissions so they can activate deferred tools already allowed by their profile; profile-specific denies must still keep those tools unavailable after expansion.
5. Set `visibleTo`, `delegationGroups`, and `hidden` deliberately. Primary agents may target only agents exposed through their catalog. Hidden BlueprintLoop and Light Loop reviewers remain host-selected rather than direct primary targets.
6. Register a new max-subagent factory in `FACTORIES`; register other new catalogs through `Agent.create()` only if a genuinely new catalog is required.
7. Update generated agent-table behavior or tests if the new agent changes routing-visible metadata. Do not maintain a second hand-written agent list in prompts or docs.
8. Keep agent registration separate from invocation. A hidden model-only agent does not by itself justify a new local `LLM.stream()` wrapper or a manually created child session.

## Verify

1. Add a behavioral or catalog test before implementation when behavior changes. Assert visibility, permission, model-role, or routing invariants rather than source text.
2. Run the narrow agent/session tests from `packages/synergy`.
3. Run `bun run typecheck` and `bun run quality:quick` from the repository root.
4. Exercise the affected primary catalog in an isolated development instance when prompt routing or delegation changed; use the `develop-synergy` skill.
5. Update `AGENTS.md` only for a durable repository rule or built-in-agent boundary, and update canonical architecture docs only when the system contract changed.

## Handoff

Report the agent class, visibility/delegation boundary, permission profile, model role, prompt location, tests run, and any deliberate catalog exclusions.
