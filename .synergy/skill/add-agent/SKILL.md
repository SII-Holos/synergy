---
name: add-agent
description: "Guide for adding a new built-in agent to Synergy. Use when creating a new agent type, modifying agent prompts, or configuring agent behavior. Triggers: 'add agent', 'new agent', 'create agent', 'agent prompt', 'agent definition'."
---

# Adding a New Built-in Agent

## Location

Agent definitions live in `packages/synergy/src/agent/`. Each agent has:

- A definition in `agents.ts` or a dedicated file
- A prompt file in `packages/synergy/src/agent/prompt/` (`.txt` files)

## Steps

### 1. Create the prompt file

Create `packages/synergy/src/agent/prompt/<name>.txt` (or `<name>/base.txt` for agents with variants).

The prompt defines the agent's identity, capabilities, and behavior. Study existing prompts:

- `synergy.txt` — orchestrator agent (complex, multi-capability)
- `master/base.txt` — implementation agent (focused on coding)
- `explore.txt` — codebase search agent (narrow scope)

### 2. Define the agent

In `packages/synergy/src/agent/agents.ts`, add the agent definition following the existing pattern. Key fields:

- `name` — unique identifier
- `description` — user-facing description
- `model` — which model role to use (e.g., `model`, `mini_model`, `thinking_model`)
- `prompt` — import from the prompt `.txt` file
- `tools` — which tools this agent has access to

### 3. Register and export

Ensure the agent is registered in the agent index so it can be discovered by the system.

### 4. Update documentation

- Update `README.md` Current Agent Model section
- Update `AGENTS.md` Current agent reality section
- If the agent is user-facing, update CLI help text

## Design principles

- **Single responsibility** — each agent should do one thing well
- **Minimal tool set** — only give agents the tools they need
- **Clear identity** — the prompt should make the agent's role unambiguous
- **Match existing patterns** — read 2-3 existing agents before creating a new one

## Key files

- `packages/synergy/src/agent/agents.ts` — agent definitions
- `packages/synergy/src/agent/prompt/` — all prompt files
- `packages/synergy/src/agent/index.ts` — agent system entry point
