# Decision Record: Delegated sessions inherit the parent session model

Status: implemented

## Problem

The native `task` tool resolved a delegated subagent's model as `Agent.getAvailableModel(agent) ?? parentModel`: the subagent's own configured or role-resolved model — typically the system default model — won over the model the parent session was actually running on. A delegated task's prompts carry parent session context (files read, conversation excerpts, user data), so every child-session turn sent that data to a provider the parent never chose. A user who deliberately ran the parent session on a local or otherwise trusted model still had their context fanned out to an external provider whenever the subagent defaulted to one. The user-facing load-bearing change came from the data-safety requirement that the delegating session's model choice is also a data boundary.

## Decision

Delegation through the native `task` tool now inherits the parent assistant message's model whenever that model is still available, resolved as `ctx.extra?.subtaskModel ?? (isModelAvailable(parentModel) ? parentModel : Agent.getAvailableModel(agent) ?? parentModel)` in `packages/harness/src/cortex/tools/task.ts`. A configured `category` model wins over inheritance and the existing optional `subtaskModel` context passthrough. The latter keeps its prior precedence, although no current repository caller writes it. When the parent model is unavailable, resolution tries the available subagent model. If neither is available, the parent reference remains the final value and normal provider resolution may fail; this change does not guarantee delegation succeeds with stale configuration. A `category` model configured without non-blank provider and model components now fails fast with a clear error instead of producing an empty modelID. The `docs/architecture/cortex.md` model-resolution paragraph describes this order.

## Alternatives considered

**Keep the subagent-default model as the primary path.** This preserves per-agent model specialization, but it routes parent session context to a provider the user did not select for that conversation, which is the defect being fixed. Agents that genuinely need a specific model remain reachable through explicit configuration on the caller's side or a category override.

**Inherit the parent model unconditionally.** Simpler, but a parent message recorded against a since-removed model would make every delegation fail hard at `getModel` time. The availability check converts that stale reference into a graceful fallback while keeping the inheritance guarantee whenever it is meaningful.

**Resolve inheritance in `Cortex.launch()` for all callers.** Plugin Host and workflow launchers already pass explicit models or have their own resolution semantics, and the manager retains its own `lastModel(parentSessionID)` backstop. Changing the shared launch path would broaden the behavior change beyond the user-facing delegation surface where the data-safety contract applies.

## Consequences

A delegated session now runs on the same provider and model as its parent by default, while that model is available. A category override or unavailable-parent fallback may select another provider. Parents running small or local models will also see subagents inherit that capability profile unless they opt out through categories, which is the intended trade. Regression coverage in `packages/harness/test/cortex/task-tool-model.test.ts` exercises the inheritance path when the parent model is available and the fallback to the subagent-configured model when it is not; the existing Cortex manager fallback test continues to cover the launcher's own backstop.

The [shared manager fallback decision](2026-08-18-cortex-parent-model-inheritance.md) remains implemented for other callers. Tests also cover category precedence and reject blank provider or model components before launching a child.
