---
name: add-agent
description: Add or change a built-in Synergy primary agent, subagent, host-selected reviewer, prompt, visibility rule, delegation group, model role, or permission profile. Use for requests about built-in agent definitions under packages/harness/src/agent; do not use for user-configured, plugin, or external agents.
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
2. Select primary identities from `agent/primary-identity` by stable responsibility; primary prompt folders and builders use `general`, `coding` and `lightweight`. Render their identity placeholders through that catalog. Add or update the prompt under `agent/prompt/`. Match the nearest flat prompt or `base.txt` plus `builder.ts` pattern. Keep product policy in code/config contracts and keep the prompt focused on the agent's role and completion criteria.
3. Define the agent with the current `Agent.Info` or `createSubagent(ctx, definition)` contract. Select the narrowest existing `SubagentPermissionProfile`; add a new profile only when no current profile expresses the required capability boundary.
4. Keep tool exposure separate from authorization. Native task-callable subagents retain the common `search_tools` and `expand_tools` permissions so they can activate deferred tools already allowed by their profile; profile-specific denies must still keep those tools unavailable after expansion.
5. Set `visibleTo`, `delegationGroups`, and `hidden` deliberately. Primary agents may target only agents exposed through their catalog. BlueprintLoop reviewers remain host-selected rather than direct primary targets, while their Cortex tasks are visible in the execution session's Task details on Workbench-enabled servers.
6. Register a new max-subagent factory in `FACTORIES`; register other new catalogs through `Agent.create()` only if a genuinely new catalog is required.
7. Update generated agent-table behavior or tests if the new agent changes routing-visible metadata. Do not maintain a second hand-written agent list in prompts or docs.
8. Keep agent registration separate from invocation. A hidden model-only agent does not by itself justify a new local `LLM.stream()` wrapper or a manually created child session.

File-interface selection belongs solely to resolved Scope configuration. Grant semantic `read`/`edit` authority and preserve role restrictions; do not select syntax through Agent-specific tool denies or anchored permission profiles. Exercise each file group for writer, reader and no-file roles. Optional owners may contribute their existing capability grants; installing an owner does not select a file group. See [file tool interfaces](../../../docs/architecture/workspace-and-files.md#file-tool-interfaces).

Keep MCP defaults in the MCP component's base permission contribution, following [MCP tool access](../../../docs/architecture/execution-boundaries.md#mcp-tool-access). When changing role templates, verify that a primary and a review child can discover and expand connected MCP tools, explicit configuration still restricts them, and invocation retains control-profile approval. Do not add per-Agent or per-profile MCP grants.

## Prompt Quality

Apply [agent-facing design](../integrate-llm/references/agent-facing-design.md) to the assembled request, not just the edited prompt file.

1. Give the agent a role that is a real-world professional identity plus a concrete domain (for example, "a social-content growth strategist focused on short-video platforms"). Reject product, brand, or codename as the role, reject pipeline-step labels ("verb + agent"), and reject generic wrappers such as "smart assistant".
2. Keep prompts of end-user-deployed agents runtime-isolated: they may not reference code-side schema, field, or class names or pipeline-position vocabulary such as upstream/downstream — write constraints as agent-facing behavior ("You receive the already-confirmed context", not "PushMessageDraft.risk_level comes from upstream"). Internal subagents that operate on this repository may keep precise code vocabulary (class and pipeline names) where it is the accurate domain language.
3. Use a layered structure: role and mission, scope and non-goals, tool authority and tool-use policy, output contract, safety and failure handling, and verification and self-check.
4. Keep prompts focused on identity, methodology and delivery. Put tool names, parameters, syntax, recovery steps and routing catalogs in tool descriptions; do not repeat them or add instructions to read descriptions already supplied to the model. Keep design rationale and migration discussion out of deployed prompts. Verify assembled prompts and complete tool descriptions together; measure UTF-8 bytes separately from provider tokens. See [single-owner tool guidance](../../../docs/decisions/implemented/simplification/2026-09-24-single-owner-tool-guidance.md).
5. Express waiting principles without tool recipes: continue independent work, wait for required results, check service readiness and diagnose from evidence. Keep notification, result retrieval and polling details in tool descriptions. See [process waiting guidance](../../../docs/decisions/implemented/bug-fix/2026-09-24-evidence-based-process-guidance.md).
6. Keep task-progress guidance in `agent/prompt/progress.ts`, selected at request preparation using the resolved model identity. Primary builders must not inline it; native and external-agent requests share the same selector. Verify excluded families, aliases, model switches and custom instructions against the final assembled request, with at most one shared policy. See [model-selected progress guidance](../../../docs/decisions/implemented/bug-fix/2026-10-26-select-progress-guidance-by-model.md). Observe real multi-step work separately: updates must add information affecting expectations or requiring attention, not reword the same issue or narrate routine calls. Refine guidance by replacing it rather than expanding its length; prompt-injection tests do not establish model behavior. Do not describe frontend grouping or event implementation to the Agent.

## Verify

1. Add a behavioral or catalog test before implementation when behavior changes. Assert visibility, permission, model-role, or routing invariants rather than source text.
   When changing the initial primary, verify catalog ordering agrees with implicit execution, explicit configuration still wins, and missing, hidden, disabled or subagent-only defaults fall back to a selectable primary. Preserve existing Session and composer choices.
2. Run the narrow agent/session tests from `packages/harness`.
3. Run `bun run typecheck` and `bun run quality:quick` from the repository root.
4. Exercise the affected primary catalog in an isolated development instance when prompt routing or delegation changed; use the `develop-synergy` skill.
5. Update `AGENTS.md` only for a durable repository rule or built-in-agent boundary, and update canonical architecture docs only when the system contract changed.

## Handoff

Report the agent class, visibility/delegation boundary, permission profile, model role, prompt location, tests run, and any deliberate catalog exclusions.

When consolidating built-in permission profiles, audit every optional domain contribution by stable registration identity. Verify media and code-evidence grants for renamed primary agents and writer/reviewer roles across each configured file interface; explicit user denials must still win.

Workflow prompts retain the complete natural-language goal and acceptance criteria through compaction and resumption. Scale investigation and planning to uncertainty; avoid mandatory document templates or automatic delegation. Light Loop completes through executor self-check; BlueprintLoop retains independent acceptance and reuses its reviewer session on rework. Verify stale task authority, cancellation and full-goal coverage when changing either path.
