# Decision Record: Add synergy-flash primary agent with deferred orchestration tools

Status: implemented

## Problem

The two built-in primary agents serve opposite regimes: `synergy` orchestrates with delegation, DAG planning, and the full classic prompt (~11k tokens of system prompt alone), while `synergy-max` runs the coding harness for heavyweight engineering work. Users asked for a third regime: a primary agent that is substantively the same as `synergy` — same execution surface, same permissions, same memory and skills — but lightweight: a much shorter system prompt, no default orchestration posture, and orchestration tooling that stays out of the tool payload until the work actually calls for it.

Folding tools away had no per-agent mechanism. `ToolExposure` groups are global (builtin groups apply to every agent; MCP groups are per-server), and the existing per-tool `exposure` field on `Tool.define` is static — it cannot vary by which agent is resolving the catalog.

## Decision

- **`synergy-flash` primary agent.** Registered in `createBuiltinPrimaryAgents` alongside `synergy` and `synergy-max`: `mode: "primary"`, not hidden, so it appears in the agent switcher and the Settings default-agent selector. It reuses `classicPrimaryPermission` verbatim — identical authorization to `synergy` (bash/process/file/web allowed, anchored-file and todo tools denied, DAG tools allowed at the permission layer).
- **Short prompt, same shape.** `agent/prompt/synergy-flash/` follows the synergy builder pattern: a compact `base.txt` (role, working style, a short "Orchestration on Demand" section, persistence) with the shared `{MEMORY_INTERACTION}` placeholder — flash gets the same dynamic memory section as the other primaries, without a hardcoded agent table.
- **Per-agent deferred tools.** `Agent.Info` gains an optional `deferredTools: string[]` (config schema, config merge in `Agent.state`, and the public OpenAPI/SDK schema updated together). `ToolRegistry.tools()` — the single point where resolver, `ToolDiscovery.collect` (expand_tools/search_tools), and auto-expand eligibility all source their definitions — applies a new `ToolExposure.deferredExposure(toolID, exposure, deferredTools)`: resident tools named in the agent's list are folded behind a shared `orchestration` group (`expand_tools({ groups: ["orchestration"] })` reveals them); exposures that are already grouped, searched, or internal pass through untouched.
- **flash defers exactly the orchestration family**: `task`, `task_list`, `task_output`, `task_cancel`, `dagwrite`, `dagread`, `dagpatch`. Everything else stays resident. Because folding happens at the registry source, the resolver's visibility filter, `expand_tools`'s group table, `search_tools` results, and the direct-call auto-expand path all see a consistent picture with no additional wiring.
- **Delegation works after expansion.** The seven legacy subagents (`developer`, `explore`, `scout`, `advisor`, `inspector`, `scribe`, `scholar`) now list `synergy-flash` in their `visibleTo` masks, so an expanded flash session can actually dispatch them. Primaries remain invisible to each other (`canDelegateTo` excludes primary mode), and flash still never appears in `synergy`/`synergy-max` agent tables.
- **No model binding.** flash runs the default model like `synergy`; users can override per config (`agent["synergy-flash"].model/modelRole`). The saved cost is the context: no agent-table payload and orchestration tool schemas only after expansion.

Expansion is ordinary `session.toolState` mutation — persisted, restored, and compaction-stable, identical to any other `expand_tools` use. Nothing about synergy or synergy-max changes; their `deferredTools` is unset and their catalogs resolve exactly as before.

## Alternatives considered

- **Model-role binding (`modelRole: "mid"`)** — rejected for this iteration: the user chose same-model parity; the config override path already supports cheap-model experiments without a code change.
- **A config-only agent in `60-agents.jsonc`** — rejected: config agents cannot inject the builder-rendered memory section, and a product-shipped primary belongs in the builtin catalog where its tests, visibility, and default-agent eligibility live.
- **A skill or subagent instead of a primary** — rejected: the request is a switchable primary identity with its own prompt and default tool posture, not a delegation target.
- **Hardcoding folded tool IDs in the registry** — rejected: per-agent data belongs on `Agent.Info` where config can extend or override it; the registry only interprets the list.
- **A new `Tool.define` exposure mode** — rejected: static per-tool exposure cannot vary by agent and would fork the exposure model; `deferredExposure` composes with the existing one instead.

## Consequences

A flash session starts with a ~2k-token system prompt (versus ~11k for synergy) and a tool payload without the seven orchestration schemas; expanding `orchestration` loads them mid-session at the cost of one cheap call. Behavior parity with synergy is preserved at the permission layer, so any existing workflow works unchanged, just without default orchestration framing. `deferredTools` is generic: any agent (builtin, config, or plugin-contributed via the config merge) can now fold arbitrary resident tools behind a group. The `orchestration` group is not in `BUILTIN_GROUPS`, so agents without a `deferredTools` overlap see no group table entry; its `whenToExpand` text carries the literal expand command for discovery outside the flash prompt.
