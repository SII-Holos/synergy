# Decision Record: Stable Instruction Presentation

Status: implemented

## Problem

Equivalent tool inventories can serialize differently because registration or connection order changes. Repeated runtime-context explanations grow with observations, while long tool tutorials and unrelated Skill branches occupy context throughout a task. Reducing these costs must preserve current permissions, complete knowledge, tool contracts and existing history.

## Decision

The model catalog sorts complete tool IDs after override, permission and availability decisions. Discovery group members, group headings and accessible Skill names use deterministic lexical ordering. Bounded catalogs sort before truncation. Worker reconstruction preserves the same ordering without transferring executable callbacks.

The common runtime-context protocol belongs to the stable system instructions of every request. New observations state facts and retain source identity, semantic kind, state, revision and verifiable text ranges. Knowledge definitions remain complete immutable versions and selection updates identify applicability. Existing persisted text and provider-specific observation layouts remain intact; no migration rewrites retained messages.

Tool prose keeps authorization, parameters, preconditions, failure distinctions and result retrieval while removing repeated tutorials. MCP owns curated model descriptions for reviewed built-in definitions. Both builtin ownership and the expected endpoint are required. A fingerprint of the complete remote definition gates each override; a changed definition uses its original prose and records a bounded diagnostic. Discovery search indexes the original remote description so curated model prose cannot remove discovery keywords. Schemas and call execution retain the remote definition. Scholight descriptions remain unchanged because their compact contracts do not justify shortening.

Repository Skills retain routing and critical constraints in their entry files. Complete specialized branches move into references with explicit must-read triggers, using the existing reference loader. The implementation and verification workflow lives in [runtime context guidance](../../../../.synergy/skill/integrate-llm/references/runtime-context.md).

## Alternatives considered

**Freeze the initial catalog.** This would hide legitimate permission, availability or tool-definition changes. Deterministic presentation operates on each current authorized snapshot instead.

**Put the protocol in a single historical observation.** Compaction, projection changes or provider switches could remove it. A stable system instruction provides it on every request without repeating it in new observations.

**Rewrite historical observations.** This would disturb retained evidence and reusable prefixes. New presentation applies only to new observations.

**Summarize arbitrary MCP descriptions or trim knowledge.** Automatic compression can remove call preconditions or substantive facts. Explicit reviewed built-in prose and untouched knowledge provide an inspectable scope.

**Require every Skill reference on entry.** This reproduces the original context cost. Routing requires only branches relevant to the active change.

## Consequences

Equivalent inventories produce equal serialized catalogs, and continuing observations no longer carry repeated protocol prose. Stable protocol text adds a small fixed request cost. These properties establish deterministic size and layout improvements; provider-reported input/cache usage and task behavior establish live effects.

Remote contract changes intentionally lose the description reduction until reviewed. Maintaining a curated override requires updating its evidence fixture and fingerprint together. Reference routing adds a read when a specialized branch becomes relevant, so acceptance must cover discovery and loading rather than only shorter entry files. Current-state invariants belong to [LLM loop](../../../architecture/llm-loop.md#prompt-assembly).
