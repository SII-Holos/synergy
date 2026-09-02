# Decision Record: Blueprint sidebar audit state from bound audit sessions, not any running child task

Status: implemented

## Problem

A BlueprintLoop-bound session showed the "Auditing Blueprint" sidebar state whenever any Cortex child task was running while the session itself was idle. Ordinary execution-phase subagent delegation (for example a `background: true` task that lets the parent session go idle immediately) therefore rendered as an audit/review state, mislabeling the loop as being in review when it was still executing. The signal conflated two distinct lifecycle phases: the loop's own audit reviewer task and everyday delegation.

## Decision

`resolveSessionVisualState` in `packages/app/src/components/sidebar/session-visual-state.ts` now derives the audit state only from the authoritative backend binding: a running Cortex task counts as auditing when the task's child session carries `blueprint.loopID` equal to the parent's bound loop and `blueprint.loopRole === "audit"` — the exact marker `BlueprintContinuationPolicy` writes to the audit session before `Cortex.start` (`packages/synergy/src/session/blueprint-continuation.ts`). Ordinary running child tasks with no such binding fall through to the "Running Blueprint" state (blueprint icon, `blueprint-running` tone, pulse) instead of the audit state. The audit-session identity branch (the reviewer child itself) keeps its existing pulse behavior. `SessionVisualStore.cortex` widened to expose each task's `sessionID` so the child session can be resolved from the store's session list; kanban panes and sidebar rows share this resolver and pick up the fix without separate wiring.

## Alternatives considered

**Keep the any-running-child heuristic and accept the mislabel.** Rejected: the mislabeled review state is exactly the user-visible defect; audit is a distinct lifecycle phase with a precise backend signal already synchronized to the frontend through `session.updated` events.

**Surface loop status from a BlueprintLoop store/event channel instead of session metadata.** Rejected for this fix: the sidebar resolver deliberately consumes the scope's shared session/cortex snapshot, and the audit binding on the child session is already that snapshot's authoritative expression of the loop's audit phase. A loop-store dependency would add a new data channel to a leaf presentation function for no additional signal.

## Consequences

Blueprint sessions delegating ordinary subagents no longer display the review icon while the parent idles; they display Running Blueprint, which matches the loop's actual `running` status. The true audit phase still displays Auditing Blueprint, now driven by the same backend marker the continuation policy relies on. The resolver became slightly more expensive (per-task child-session lookup) but stays linear over the scope's task and session lists and only inside the blueprint-bound branch. If a future audit mechanism binds the reviewer differently, the sidebar audit state must follow that binding rather than reverting to a child-count heuristic.
