# Decision Record: Auto-expand deferred tools on direct model call

Status: implemented

## Problem

Synergy defers long-tail tool groups (`browser`, `agenda`, `session`, `note`, `memory`, `email`, `worktree`), search-only tools, and large MCP server groups to keep the model's tool context small. An agent must call `expand_tools` before using one of those tools. But the model often knows a deferred tool exists from memory, prompts, or prior turns, and calls it directly. The call reaches a diagnostic stub that fails with "not currently visible. Use search_tools or expand_tools…", forcing the model to spend an extra LLM round-trip expanding and retrying — and sometimes the model gives up instead.

## Decision

When the model directly calls a tool that exists in the current session's tool registry but is not yet visible because its group is not expanded or it is a search-only tool not yet activated, the runtime now auto-expands it and executes the call in the same turn, without requiring a prior `expand_tools` call and without a wasted retry round-trip.

Mechanism (processor-side interception + resolver-provided eligibility):

- `ToolResolver.applyAvailability` computes `autoExpandable`: tools hidden only by exposure (`reason: "deferred"`), with `group` or `search` exposure, that pass agent/session permission, `userTools`, and the `expand_tools` permission check. Mode-blocked, permission-denied, `userTools`-disabled, `internal`/ephemeral, schema-failed, and truly unknown tools are never auto-expandable and keep their existing diagnostics.
- The session processor suppresses the `tool-error` failure record and error-settlement for auto-expandable calls whose part is `running`, then, at deferred dispatch, calls `ToolResolver.autoExpandTool`, which persists the expansion through the canonical `session.toolState` (same state as `expand_tools`, under the same `Session.update` mutation lock), re-resolves the runtime tool against a fresh session snapshot, swaps it into `executionTools`, and dispatches normally through the existing scheduler/executor/gate pipeline.
- Auto-expanded calls are observable: the tool part carries `metadata.autoExpanded: true`, a `tool.auto_expanded` observability event is emitted with the group or activated tool, and the Web UI shows a muted "Auto-loaded" tag.
- Always on; no configuration flag. Expansion is indistinguishable from a manual `expand_tools` call for future turns.

## Alternatives considered

- **Auto-execute inside the diagnostic stub** — rejected: the stub is wrapped in `withExecutionDeduplication`; calling the also-wrapped real tool's `execute` re-enters `executeOnce(callID, …)`, which returns the outer in-flight promise → deadlock. It also cannot prevent the `tool-error` settlement that error-settles the part before dispatch; the processor change is required anyway.
- **Reordering `applyAvailability` checks** so `deferred` implies authorized — rejected: changes observable diagnostic messages for user-disabled hidden tools and broadens the change's surface. The eligibility re-check achieves fail-closed without reordering.
- **Prompt-only fix** (tell models to always expand first) — rejected: does not handle hallucinated or remembered calls and leaves the round-trip latency.
- **Auto-expand but return an error asking the model to retry** — rejected: wastes a full LLM round-trip and contradicts the same-turn-execution requirement.
- **New config flag `experimental.auto_expand_tools`** — rejected: always-on is the product decision; the mechanism is visibility-only and never bypasses authorization, so a kill switch would only hide context-budget behavior that `expand_tools` already controls.
- **Separate persisted state for auto-expansions** — rejected: reuses the canonical `toolState`; no migration, no parallel state.
- **MCP groups excluded** — rejected: direct calls to exact MCP tool IDs are the primary hallucination/recall case; the permission gate for the MCP server still applies.

## Consequences

- Direct calls to deferred-but-authorized tools now succeed in one turn instead of failing with a diagnostic; the model's recalled knowledge of long-tail tools becomes usable without a two-step expand-then-retry dance.
- Auto-expansion is strictly a visibility change: it never grants authorization, never bypasses permission/`userTools`/mode/workflow policy, and is disabled for agents denied `expand_tools`. The security boundary documented in `docs/architecture/execution-boundaries.md` is preserved.
- Expanding a large MCP server group on a single direct call adds that server's schemas to subsequent turns' context — identical to manual expansion; existing prompt budget/compaction handles overflow.
- One extra resolver re-resolution per auto-expanded tool call per turn; cached per tool within the turn.
