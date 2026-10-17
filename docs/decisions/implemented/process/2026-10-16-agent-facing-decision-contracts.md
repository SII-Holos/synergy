# Decision Record: Agent-facing decision contracts

Status: implemented

## Problem

Individually concise prompts can still repeat tool tutorials, implementation protocols and selection advice when assembled. Separate discovery and model-description layers can also overwrite one another, hiding a changed remote contract.

## Decision

Agent-facing text is designed around decisions and effective action. Each fact has one owning surface: role, discovery, invocation contract, observation, result or specialist guidance. Internal mechanisms are described only when they affect an action, interpretation or recovery. Concision preserves authority, uncertainty, full task requirements and necessary completion boundaries.

The root rules route changes to the [design workflow](../../../../.synergy/skill/integrate-llm/references/agent-facing-design.md). MCP owns reviewed remote descriptions; capability discovery owns labels and grouping and cannot replace those descriptions again. Integration tests inspect the effective description after both layers, including changed definitions.

## Alternatives considered

**Apply independent length limits to every surface.** Rejected because late exclusions and failure constraints can be lost while repeated meanings remain.

**Explain runtime mechanisms in each observation and result.** Rejected because repetition grows with execution length and consumes attention without helping the next decision. Shared interpretation rules remain once per effective request.

## Consequences

Prompt review includes assembled requests and tool results, with behavioral and real-model evidence. Some precise identifiers and workflow instructions remain because actions depend on them. Shorter text alone is not a quality or cache-efficiency claim.
