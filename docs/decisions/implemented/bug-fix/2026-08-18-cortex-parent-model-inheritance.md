# Decision Record: Cortex tasks inherit the parent session model when the agent has none

Status: implemented

## Problem

`Cortex.runTask()` was the only model-resolution point in the codebase without a fallback chain: it resolved the task model as `model ?? Agent.getAvailableModel(agent)` and threw `No model configured for agent <name>` when both were empty. Every comparable call site (`session/input.ts` createUserMessage, `tool/task.ts` task launch, `plugin/host-services.ts` delegation) falls back to the parent session's model or the provider default.

A custom subagent without a `model`/`modelRole` (e.g. a user-configured `reviewer` agent) could therefore be selected as a BlueprintLoop `auditAgent` and launched successfully through `Cortex.prepare`, then fail at run time with `ERROR service=cortex error=No model configured for agent reviewer`. The Blueprint continuation policy retried the same unconfigured reviewer (`ReviewToolRecovery.MAX_ATTEMPTS = 2`), each attempt failing identically, and the loop ended in `failed` with `review_terminal_tool_missing` — surfacing to the user as a stuck `[Cortex] [Review] Audit BlueprintLoop …` child session with no interaction. Light Loop was unaffected only because its default `lightloop-reviewer` agent ships with `model: "thinking"`; a custom LightLoop review agent without a model would fail the same way.

## Decision

`Cortex.runTask()` now resolves the model as:

```
model ?? Agent.getAvailableModel(agent) ?? lastModel(task.parentSessionID)
```

`lastModel` (from `session/input.ts`) returns the last user-anchor model in the parent session, falling back to `Provider.defaultModel()`. This makes Cortex task model resolution consistent with the rest of the codebase and lets subagents without an explicit model inherit the calling session's model instead of failing.

## Alternatives considered

- **Require every agent to declare a model** — rejected: it breaks user-configured and plugin agents that intentionally omit a model, contradicts the fallback semantics used everywhere else, and does not fix loops already recorded with an unconfigured audit agent.
- **Fall back only to `Provider.defaultModel()`** — rejected: it ignores the natural inheritance from the parent session (the loop execution session), which is what the task/plugin call sites use and what makes a custom reviewer run on the same model family as the loop that spawned it.

## Consequences

Cortex tasks now behave like every other delegation path: explicit task model wins, then the agent's configured/role model, then the parent session model, then the provider default. The `No model configured for agent` error remains only for environments with no providers configured at all. The behavioral contract is covered by a regression test in `test/cortex/manager.test.ts` that forces `Agent.getAvailableModel` to return `undefined` and asserts the task receives the parent session model.
