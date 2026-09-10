# Decision Record: Delegated sessions inherit the parent session model

Status: implemented

## Problem

The native `task` tool resolved a delegated subagent's model as `Agent.getAvailableModel(agent) ?? parentModel`: the subagent's own configured or role-resolved model — typically the system default model — won over the model the parent session was actually running on. A delegated task's prompts carry parent session context (files read, conversation excerpts, user data), so every child-session turn sent that data to a provider the parent never chose. A user who deliberately ran the parent session on a local or otherwise trusted model still had their context fanned out to an external provider whenever the subagent defaulted to one. The user-facing load-bearing change came from the data-safety requirement that the delegating session's model choice is also a data boundary.

## Decision

Delegation through the native `task` tool now inherits the parent assistant message's model whenever that model is still available, resolved as `ctx.extra?.subtaskModel ?? (isModelAvailable(parentModel) ? parentModel : Agent.getAvailableModel(agent) ?? parentModel)` in `packages/harness/src/cortex/tools/task.ts`. An explicit task model still wins outright: a `category` model override and the `subtaskModel` passthrough are intentional caller choices and keep precedence over inheritance. The availability guard keeps a stale parent reference — for example a model the user has since removed from their configuration — from being handed to `Cortex.launch()`, where it would fail instead of delegating; in that case resolution falls back to the subagent's configured model, with the parent model retained as the final reference before the system fallback. A `category` model configured without a `provider/model` separator now fails fast with a clear error instead of producing an empty modelID. The `docs/architecture/cortex.md` model-resolution paragraph describes this order.

## Alternatives considered

**Keep the subagent-default model as the primary path.** This preserves per-agent model specialization, but it routes parent session context to a provider the user did not select for that conversation, which is the defect being fixed. Agents that genuinely need a specific model remain reachable through explicit configuration on the caller's side or a category override.

**Inherit the parent model unconditionally.** Simpler, but a parent message recorded against a since-removed model would make every delegation fail hard at `getModel` time. The availability check converts that stale reference into a graceful fallback while keeping the inheritance guarantee whenever it is meaningful.

**Resolve inheritance in `Cortex.launch()` for all callers.** Plugin Host and workflow launchers already pass explicit models or have their own resolution semantics, and the manager retains its own `lastModel(parentSessionID)` backstop. Changing the shared launch path would broaden the behavior change beyond the user-facing delegation surface where the data-safety contract applies.

## Consequences

A delegated session now runs on the same provider and model as its parent by default, so the parent's model selection acts as a single data boundary for everything the delegation touches. Parents running small or local models will also see subagents inherit that capability profile unless they opt out through categories or explicit agent models, which is the intended trade. Regression coverage in `packages/harness/test/cortex/task-tool-model.test.ts` exercises the inheritance path when the parent model is available and the fallback to the subagent-configured model when it is not; the existing Cortex manager fallback test continues to cover the launcher's own backstop.
