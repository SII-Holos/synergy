# Decision Record: Delegated tasks can choose a configured model

Status: implemented

## Problem

The native `task` tool inherited the parent assistant message's model whenever that model was still available. That preserved the data boundary from [Delegated sessions inherit the parent session model](../bug-fix/2026-09-10-delegation-inherits-parent-model.md), but it also meant a primary agent could not choose a smaller or stronger model for a subagent even when the user had already configured that choice. Category presets could switch models, yet the agent never saw the resolved provider and model IDs, and a category prompt could silently replace a model the caller thought it had selected.

## Decision

The native `task` tool accepts an optional `model` argument. Omitting it keeps the existing inheritance chain: category model, then host `subtaskModel`, then the available parent model, then the agent's available model, then the parent reference. Empty or whitespace-only input follows that same chain; the tool normalizes the input before deciding whether the category supplies the model. Passing `model` selects either a role (`parent`, `default`, `nano`, `mini`, `mid`, `thinking`, `long`, `creative`) or an explicit `provider/model`. A role resolves through the user's configured role chain. An explicit ID is accepted only when `Provider.isModelAvailable` says the model is connected and selectable. An unavailable or malformed choice fails before launch and includes the current menu; it does not fall back.

When the tool is exposed, its description appends that menu: the current turn's model when known, plus configured roles whose resolved models are available. The full provider catalog is not inlined. `vision` is excluded because it serves image analysis, not delegation. Category text is still appended when a category is set, but its model no longer overrides an explicit `model` argument. Plugin task starts and workflow reviewers keep their existing resolution.

## Alternatives considered

**Inline the full connected catalog in the tool description.** The agent could then pick any selectable ID without a role alias, but a connected provider can expose dozens or hundreds of models. That cost is paid on every turn the tool is visible, and it invites selection of a model the user connected for another purpose. The role menu plus an availability-checked explicit ID covers the same authorization boundary without the catalog dump.

**Accept only role aliases.** This is smaller, but it cannot express a connected model that the user has not assigned to a role. The explicit `provider/model` form keeps that choice available while still rejecting models that are not currently selectable.

**Apply the same choice in `Cortex.launch` for every caller.** Plugin Host and workflow launchers already pass explicit models or rely on the manager fallback. Changing the shared launch path would alter callers that did not ask for a model menu. The choice stays on the native `task` tool.

## Consequences

A primary agent can now send a delegated task to another provider the user has connected and configured. The default remains the parent model, so ordinary delegation does not change providers. An explicit choice that is unavailable fails visibly instead of silently inheriting the parent. Category presets no longer override an explicit model, which removes a hidden replacement but also means a category's role model applies only when `model` is omitted. Category temperature remains unused by dispatch. The architecture note is in [Cortex delegation](../../../architecture/cortex.md).
