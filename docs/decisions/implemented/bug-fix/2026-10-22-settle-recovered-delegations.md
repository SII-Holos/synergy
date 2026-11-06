# Decision Record: Settle delegations that a restart left terminal but unsettled

Status: implemented

## Problem

Settlement is what tells the parent that a delegated child will never produce more work. `Cortex.settledAt` is the field the parent's rollout reconciliation reads before it is allowed to close the parent run, and `TurnExecutionState` reads the same field to decide whether a root is still busy. Only the live terminal path wrote it, and only after the parent notification succeeded.

A restart breaks that pairing. `reconcileInterruptedCortexDelegations` marks a child `interrupted` and writes `completedAt`, but it does not settle it. Startup then calls `Cortex.reconcileParentNotifications`, which finds `deliveryNotifiedAt` already set, confirms the notification is still in the parent's Inbox, requests the parent drive and stops. Nothing writes `settledAt`.

The child is terminal, the parent has been told, and the field that both the parent run and the session activity projection gate on stays empty indefinitely. The parent run cannot close: `RolloutLifecycle.reconcile` returns early while an owning child lacks `settledAt`, so `run.status` keeps its pre-crash `running` value even though `run.execution` already records the turn's real failure. `/session/{sessionID}/turn-execution` reports the root as running with no stop evidence, and the next input cannot skip that root, because only `completed`, `failed` and `cancelled` are terminal for that decision. One observed session held this state for nearly four hours across two `interrupted` children.

The gap also outlives the one-shot migration that repaired history. `20260907-session-rollout-evidence` backfills `settledAt` for terminal delegations that lack it, but it runs once per owner and never again, so every newly interrupted delegation reopens the same hole.

## Decision

`Cortex.settleDelegation` is the single settlement step, and both the live terminal path and the recovery path call it.

The step keeps the ordering the live path already required: release the child's detached work, release its managed worktree, then record `settledAt` and reconcile the parent run. `delivered` is the only difference between the callers. The live path passes its parent-notification result; recovery passes `true` because it settles only after a notification is durable or already recorded as delivered. Settlement before delivery would close the parent run against an Inbox that has not received the message yet, which is the ordering [continuation admission](./2026-09-10-rollout-continuation-settlement.md) established.

`notifyParentSession` now reports whether it delivered, so recovery can distinguish a delivered notice from one suppressed for its task without re-reading the child. A task whose notification intent is `false` keeps its own path: its handoff belongs to the silent-drive branch.

Recovery settles named notifications once delivery succeeds, and silent handoffs once the parent drive succeeds. Those are the two places a restart can leave a terminal child paired with a delivered-but-unsettled parent. Both are idempotent: `settledAt` is written only when absent, and settlement itself runs no destructive step twice.

## Alternatives considered

**Relax the parent-run guard so any terminal child unblocks the run.** This removes the failure mode with a one-line change, and `CortexTypes.isTerminalStatus` already accepts `interrupted`. Rejected because `settledAt` is not a duplicate of the status. It records that detached work and the managed worktree are released, and that the parent was actually told. A terminal child whose worktree cleanup never ran would then close its parent run while still owning resources. The guard is correct; the writer was incomplete.

**Write `settledAt` where the status becomes `interrupted`.** This is what the field's name suggests and it is the smallest diff. Rejected because at that moment the parent notification has not been sent, so the parent run would close before the notice lands, which is the exact race continuation settlement exists to prevent. Status transition and settlement are separate facts with a required order.

**Let each recovery branch keep its own copy of the settlement steps.** Rejected because the live path and recovery would then drift. The live path's three steps were already inlined once, and duplicating them twice more is how the original omission happened. One function keeps the ordering in one reviewable location.

**Depend on the history migration to fill `settledAt`.** Rejected because the migration is version-scoped, runs once per owner, and by construction cannot cover delegations interrupted after it ran.

## Consequences

A parent run whose owning child was interrupted by a restart now closes on the next recovery pass instead of staying `running`. The run keeps `interrupted` rather than the `failed` its own segment recorded, because `interrupted` is the only terminal status that admits another execution segment; recording `failed` there would make the run permanently unresumable. The observable improvement is that a root stops reporting as running and a new task no longer has to replay the old root first.

Recovery now performs work it previously skipped for terminal delegations: one detached-work settlement, one worktree cleanup attempt, one `settledAt` write and one parent reconcile per affected child. Cleanup already returns early when the session holds no managed worktree, so a repeated pass costs bookkeeping rather than filesystem work.

Settlement for tasks whose notification intent is `false` still depends on a successful parent drive. A failed drive leaves them unsettled on purpose: an undelivered silent handoff is unfinished work, not a completed delegation.

`packages/harness/test/cortex/delegation-recovery-settlement.test.ts` starts from a terminal child carrying `deliveryNotifiedAt` and no `settledAt`, runs `Cortex.reconcileParentNotifications`, and asserts both the child's `settledAt` and the parent run's closure. `packages/harness/test/session/turn-completion.test.ts` retains the guard's own contract: an owning child that is terminal but unsettled still keeps the reply open.
