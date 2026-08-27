# Decision Record: Subagent expansion detail for Balanced activity trace

Status: implemented

## Problem

In Balanced activity display, expanding a `task` (delegated subagent) step in the Activity Trace rendered nothing useful: `ToolResultBody(resultOnly)` strips the `BasicTool` trigger header, leaving only the raw `metadata.summary` tool-row list, and background delegations return `summary: []` at dispatch time with no later updates, so their expansion was permanently blank. Activity receipts for delegate-family tools had no `specializedActivityDetail` branch at all, so they rendered without an expansion affordance. The delegation data itself (subagent type, description, background flag, child `sessionId`, live `summary` snapshots) was already present in tool metadata — only the presentation consumed it.

## Decision

Delegated subagent expansion now reuses the Full-mode information architecture through one shared component instead of two ad-hoc presentations:

- `packages/ui/src/components/tool/task-subagent-detail.tsx` owns the presentation: an agent-type and background badge header, the delegation description, the parsed `metadata.summary` tool-step list (with a spinner on the running step and the completed title otherwise), an honest empty state for background delegations with no recorded steps, and an explicit "Open subagent session" action wired to `useData().navigateToSession`.
- The Full-mode `task` renderer keeps its trigger card but delegates its body rows to the same `TaskSubagentSteps` list, so Full and Balanced render identical step rows from one implementation.
- `basic-tool.tsx` exposes `useToolResultPresentation()` so a registered tool renderer can detect that it sits inside a result-only surface; the `task` renderer returns the shared detail directly in that case.
- `specializedActivityDetail()` gained a `subagent` kind for `family === "delegate"` on the `task` tool, so Activity Trace steps and Activity Receipts both expand into the same detail through the existing specialized-detail slot.
- The detail renders on the standard `tool-output` surface (the same inset background, border, and scroll treatment every other expanded tool result uses) instead of a bespoke container, so Balanced expansions are visually indistinguishable from sibling tools.

Background delegations keep their empty `summary` snapshot (the backend dispatch path has no live subscription after return); the detail states this plainly with a running-in-background label plus the open-session action rather than pretending to show progress.

## Alternatives considered

**An empty-state-only fallback card inside the task renderer** was rejected as too thin: it fixed only the blank background case while completed delegations still rendered a bare unlabeled row list and receipts stayed non-expandable. It survives as the empty-state branch inside the shared detail.

**Live child-session subscription for expansions** was rejected for this change: Full mode itself renders from the same `metadata.summary` push stream, so Balanced would have gained a data path Full does not have, plus view-layer plumbing for arbitrary-session reads and pagination. The open-session action covers the "I want the real progress" case by navigating to the child session, which is the durable surface for it.

**Rendering the trigger header inside the expansion** was rejected because result-only surfaces own their header row by contract; duplicating a trigger inside the body would fight the surrounding Activity Trace row for hierarchy and reintroduce nested-card chrome.

## Consequences

Balanced-mode subagent steps and receipts both expand into a meaningful detail with identity, description, step timeline, and navigation, at the cost of one new shared component and a `useToolResultPresentation` context hook on the basic-tool surface. Full and Balanced task rendering now share one step-list implementation, so their presentation cannot drift independently. Background expansions show a static-but-honest state until the backend learns to push summaries after background dispatch; when that lands, the shared detail renders the new data without further UI changes.
