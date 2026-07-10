---
name: add-agent
description: "Guide for adding a new built-in agent to Synergy. Use when creating a new agent type, modifying agent prompts, or configuring agent behavior. Triggers: 'add agent', 'new agent', 'create agent', 'agent prompt', 'agent definition'."
---

# Adding a New Built-in Agent

## Location

Agent definitions live in `packages/synergy/src/agent/`. The key files:

| File                          | Purpose                                                                         |
| ----------------------------- | ------------------------------------------------------------------------------- |
| `agent.ts`                    | `Agent` namespace, schema, model-role defs, `Agent.create()` assembler          |
| `builtin-primary.ts`          | Primary orchestrator agents (`synergy`, `synergy-max`)                          |
| `builtin-max-subagents.ts`    | Coding-harness subagents (`implementation-engineer`, `code-cartographer`, etc.) |
| `builtin-legacy-subagents.ts` | Classic subagents (`developer`, `explore`, `scout`, etc.)                       |
| `builtin-internal.ts`         | Hidden/internal agents (`supervisor`, `lightloop-reviewer`)                     |
| `builtin-context.ts`          | `BuiltinAgentContext` interface and `createSubagent()` factory                  |
| `delegation.ts`               | Delegation logic                                                                |

There is **no `agents.ts`** and **no `agent/index.ts`**. The entry point is `agent.ts`.

## Prompt Files

Prompt files live in `packages/synergy/src/agent/prompt/`. There are **two patterns**:

### Pattern A: Flat `.txt` — simple single-prompt agents

```txt
prompt/
  explore.txt        # flat file, imported as string
  scout.txt
  advisor.txt
```

Used by simple agents like `explore`, `scout`, `advisor`, etc.

### Pattern B: Subdirectory with `base.txt` + `builder.ts` — complex agents

```
prompt/
  synergy/
    base.txt          # prompt template with {PLACEHOLDER} markers
    builder.ts        # dynamic composition: injects agent table, memory rules, etc.
  synergy-max/
    base.txt
    builder.ts
  developer/
    base.txt
    builder.ts
```

Used by complex agents whose prompts include dynamically generated sections (agent catalog tables, memory interaction rules, tool descriptions). The `builder.ts` exports a function that reads `base.txt` and replaces `{PLACEHOLDER}` tokens at runtime.

## Steps

### 1. Choose the right file

- **Primary orchestrator** → `builtin-primary.ts`
- **Coding-harness subagent** (visible to `synergy-max`) → `builtin-max-subagents.ts`
- **Classic subagent** (visible to `synergy`) → `builtin-legacy-subagents.ts`
- **Hidden/internal** (reviewers, audit agents) → `builtin-internal.ts`

### 2. Create the prompt

- For simple agents: create a flat `prompt/<name>.txt`
- For complex agents: create `prompt/<name>/base.txt` + `prompt/<name>/builder.ts`

Study existing prompts:

| Agent         | Prompt                                       | Pattern      |
| ------------- | -------------------------------------------- | ------------ |
| `explore`     | `prompt/explore.txt`                         | Flat `.txt`  |
| `scout`       | `prompt/scout.txt`                           | Flat `.txt`  |
| `synergy`     | `prompt/synergy/base.txt` + `builder.ts`     | Subdirectory |
| `synergy-max` | `prompt/synergy-max/base.txt` + `builder.ts` | Subdirectory |
| `developer`   | `prompt/developer/base.txt` + `builder.ts`   | Subdirectory |

### 3. Define the agent

In the appropriate `builtin-*.ts` file, use `createSubagent()` from `builtin-context.ts`:

```ts
export function createBuiltinXxxSubagents(ctx: BuiltinAgentContext): Record<string, Agent.Info> {
  const sub = createSubagent(ctx)
  return {
    "my-agent": sub({
      name: "my-agent",
      description: "What this agent does",
      prompt: myAgentPrompt, // imported from prompt file or builder
      model: "mid", // Provider.ModelRole
      permission: "codeWrite",
      visibleTo: ["synergy-max"],
      delegationGroups: ["coding"],
    }),
  }
}
```

Key `SubagentDefinition` fields:

| Field              | Description                                                                                                                                                                                                  |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `name`             | Unique identifier                                                                                                                                                                                            |
| `description`      | Shown in agent table and selection                                                                                                                                                                           |
| `prompt`           | Prompt string (imported from `.txt` or builder)                                                                                                                                                              |
| `model`            | Model role: `nano`, `mini`, `mid`, `model`, `thinking`, `long_context`, `creative`, `vision`                                                                                                                 |
| `permission`       | Permission profile: `readOnly`, `codeWrite`, `anchoredCodeWrite`, `testWrite`, `docsWrite`, `quality`, `memory`, `note`, `research`, `externalResearch`, `sessionHistory`, `supervisor`, `lightLoopReviewer` |
| `visibleTo`        | Which primary agents can see this subagent (e.g., `["synergy-max"]`)                                                                                                                                         |
| `hidden`           | Hide from agent catalog (for internal reviewers)                                                                                                                                                             |
| `delegationGroups` | Group for auto-delegation routing                                                                                                                                                                            |
| `steps`            | Max tool call steps                                                                                                                                                                                          |
| `temperature`      | Model temperature override                                                                                                                                                                                   |
| `topP`             | Model top_p override                                                                                                                                                                                         |

### 4. Registration

The agent is auto-registered by `Agent.create()` in `agent.ts`. It merges all four `createBuiltin*` functions:

```ts
const result: Record<string, Info> = {
  ...createBuiltinPrimaryAgents(builtinContext),
  ...createBuiltinLegacySubagents(builtinContext),
  ...createBuiltinMaxSubagents(builtinContext),
  ...createBuiltinInternalAgents(builtinContext),
}
```

Your `createBuiltinXxxSubagents` function must be **imported and spread** here for the agent to be available.

### 5. Update documentation

- If the agent is user-facing, add it to the agent table in relevant prompt builders (`prompt/synergy/builder.ts`, `prompt/synergy-max/builder.ts`)
- Update `AGENTS.md` agent reality section

## Design Principles

- **Single responsibility** — each agent should do one thing well
- **Minimal tool set** — only give agents the tools they need (permission profile controls this)
- **Clear identity** — the prompt should make the agent's role unambiguous
- **Match existing patterns** — read 2–3 existing agents in the target file before creating a new one

## Quality Verification

Before committing a new agent:

```bash
bun run typecheck          # verify no type errors
bun run quality:quick      # format:check + lint + typecheck + monorepo:check + package:check
```

Add tests if the agent introduces new tool interactions or prompt variants.
