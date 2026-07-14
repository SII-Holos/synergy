# Workflow Runtime

This document defines two orchestration layers. A session's workflow field stores one session-local kind—`plan`, `lightloop`, or `lattice`—while BlueprintLoop keeps a separate execution record bound to that session. WorkflowRun is the Scope-level layer for one Boss session coordinating durable worker seats and many state-machine entities across sessions.

These workflows provide durable orchestration above the ordinary serial LLM loop.

## Mutual Exclusion and Ownership

Workflow changes require an idle session. Plan and Light Loop cannot be enabled while another workflow or active BlueprintLoop exists. Lattice can resume its own run but refuses a live user-owned BlueprintLoop.

A user-owned BlueprintLoop can replace Plan or Light Loop after the session is idle. It cannot replace an active Lattice workflow. A BlueprintLoop with `source: "lattice"` is valid only while Lattice owns the session.

Disabling Lattice first pauses the run, then cancels any active Lattice-owned BlueprintLoop so terminal loop events cannot advance an inactive Pathway.

WorkflowRun ownership is independent of the session-local workflow field. A participating session has one `workflowRun` binding: the owning session is the `boss`, and lazily created worker sessions are `seat` instances. One Boss session cannot own two active or paused runs simultaneously; after a run is terminal and its binding is cleared, the same session may start another. The run snapshot, not a session tree or live runtime map, is the authority for run status, entity state, seat allocation, gates, pending effects, and budget.

## WorkflowRun and Boss Mode

A Charter is an immutable, versioned definition of an organization. It declares entity states, event/intent/gate transitions, fixed guard and effect references, seat pools, worktree policy, gates, and the default model-call budget. Updating a Charter creates a new version; an existing run remains pinned to the exact version with which it started.

A WorkflowRun instantiates one Charter in a Scope. It owns:

- one Boss session as the human and agent control plane
- durable seat bindings whose worker sessions are created only on first use
- entities moving through the Charter state machine
- pending human gates, an effect outbox, effect receipts, and a model-call budget
- an append-only event stream for audit and incremental presentation

The mutable run snapshot is the recovery source of truth. Events are an audit projection and must not be replayed to reconstruct canonical state. Every command reloads current state and requires an active run before committing. Entity transitions are serialized per run and use source-state checks; shared-resource guards such as seat availability are rechecked inside that serialization boundary. Losing a seat race leaves the entity in its source state for a later redrive rather than blocking it as a business failure.

Transitions commit the target state and a pending-effect record before executing external effects. Effects run in order, record durable idempotency receipts, and remove their outbox entry only after completion. Startup reconciliation validates the Boss binding, repairs or blocks stale seat references, and drains pending effects for active runs. A failed effect blocks its entity and notifies the Boss; it is never silently discarded.

Seat sessions are durable workers, not Cortex tasks. Handoffs use the persistent session Inbox with stable workflow metadata so delivery survives restart and can be deduplicated. Inbox task consumption first materializes the preallocated message ID idempotently and only then commits item removal; a crash can replay either side without losing or duplicating the task. `handoff_acked` is a rebuildable projection of durable message metadata with a stable event ID, while the message bus is only its fast path. A seat is atomically leased to one entity, and only that seat session may submit the entity's allowed intent. A Charter is orchestration data, not an authorization grant: run creation freezes the Boss session's then-effective control profile as an explicit durable cap, records the Boss's prior raw profile for cleanup, every seat inherits the cap, and no Charter field can broaden the permission or sandbox boundary. Generic session profile updates are rejected while a WorkflowRun binding remains; restart recovery atomically restores the binding and cap for an active Boss or clears a terminal Boss binding and restores the recorded prior profile. Contractors remain bounded Cortex tasks with an explicit `workflow_run` owner and report their result back through the WorkflowRun bridge.

Worktree policy has literal ownership semantics:

- `none` keeps the seat in its ordinary workspace
- `shared` gives that seat instance one long-lived workspace
- `per_entity` gives the entity one workspace that follows it between seats

Cortex cleans up only worktrees it created for its own task. It must not remove a seat- or entity-owned workspace.

Pause is a cooperative scheduling fence: it stops new transitions and effects, makes workflow seat Inbox tasks non-runnable without consuming them, and does not pretend an already-running model call was rolled back. Resume wakes eligible durable seat work again. Every internal or external provider invocation made by an active Boss, seat, or workflow-owned contractor first reserves one call from the run's durable shared budget. Paused and terminal runs reject seat and contractor invocations before the provider, while the Boss remains conversational without consuming execution budget so it can inspect, resume, cancel, or move on. Cancel first commits a terminal run fence and clears pending effects and seat leases, then stops worker execution and owned loops/tasks; after that stop succeeds, it conditionally clears only this run's Boss session binding and restores its prior raw control profile. The Boss session itself is not cancelled. Once a run is terminal, late intents, gates, bridge events, recovery, and effect workers cannot mutate it. Run creation may atomically replace a stale terminal Boss binding left by an interrupted cleanup, but it cannot replace an active or paused binding.

Boss Mode is presented as a session-scoped workbench panel. It shows only runs owned by the current Boss session, preserves the last valid snapshot during refreshes, merges event pages by stable event ID, and requires shared destructive-action confirmation for cancellation. Worker sessions remain reachable through the current session's child-session surface rather than being promoted into a global sidebar hierarchy.

## User-Message Projection

Workflow instructions are projected into model context without rewriting the stored user text. Root, user-origin messages receive compact workflow metadata when they are created. During context assembly, the first user text part is wrapped with the agent-specific Plan, Lattice, or Light Loop contract.

System control messages, non-root messages, and messages from continuation sources are not wrapped again. This keeps the durable transcript faithful to what the user wrote while making the active contract explicit to the model.

## Plan Enforcement

Plan prompts instruct the agent to research and author a decision-complete Blueprint instead of executing the result. Tool exposure and execution policy enforce the read-only project boundary in addition to the prompt.

The Note Blueprint policy allows Blueprint creation and modification only in Plan or Lattice. It infers Blueprint intent from `kind` or Blueprint-specific fields and blocks edits to an existing Blueprint outside those workflows. Reading and searching remain available.

## BlueprintLoop State Machine

A BlueprintLoop persists:

- Blueprint note ID and optional version
- execution session and optional parent session
- execution and audit agents
- audit session and Cortex task IDs
- `current`, `new`, or `worktree` run mode
- optional model and run-specific user instruction
- source ownership, loop index, audit attempts, error, and timestamps

Its states are:

```text
armed → running → auditing → completed
             ↑        │
             └────────┘ rejection

armed/running/waiting/auditing → failed | cancelled
```

The execution session is marked with `loopRole: "execution"`; the hidden review child is marked with `loopRole: "audit"`. Only the execution session can call `blueprint_loop_stop`, and only the recorded audit session can approve or reject.

`blueprint_loop_stop` moves the loop to `auditing` only after its hidden Cortex reviewer has been launched and bound. Rejection increments the audit attempt record, returns the loop to `running`, and delivers instructions. Approval marks it `completed` and emits a terminal loop event.

For user-owned loops, approval returns a completion notice to the execution session. For Lattice-owned loops, approval tells the session to analyze and record the step result instead of stopping at a user-facing summary.

## Light Loop State

Light Loop stores its task description directly on the session workflow. A stop request contains the executor's summary, claimed completed work, evidence, limitations, request identity, and the hidden review task/session IDs.

The write that records a stop request includes both reviewer IDs atomically. Repeated `loop_stop` calls are idempotent while that review is pending.

The `lightloop-reviewer` has exclusive access to `light_loop_approve` and `light_loop_reject` for its parent stop request. Approval clears the workflow even though the review child is running. Rejection clears `stopRequest`, records attempt metadata, and delivers the reason, remaining items, and concrete instructions to the execution session.

## Lattice Run State

A Lattice run is keyed to one session and contains:

- `auto` or `collaborative` mode
- active, paused, completed, failed, or cancelled status
- current phase and step
- ordered Pathway steps
- model-call count and optional maximum
- run assumptions, status reason, and event history

Step states are `pending`, `ready`, `blueprinting`, `reviewing`, `running`, `completed`, `failed`, `blocked`, or `cancelled`.

The Lattice machine is the only owner of phase and Pathway mutations. Agent-facing tools submit patch intents; the machine preserves terminal steps, freezes Pathway restructuring during execution, prevents a running step from being dropped or changing objective, selects the next ready step, and completes the run when no selectable step remains.

Binding a Blueprint advances `step_blueprinting` to `blueprint_review` in collaborative mode or `blueprint_execution` in auto mode. Collaborative continue starts the current step explicitly. Auto mode starts it from the continuation policy.

The Lattice bridge consumes terminal events only from loops whose source is `lattice` and only while the owning run is active. Completion moves the step to `completed` and the run to `result_analysis`; failure and cancellation produce their corresponding deterministic transitions.

Model calls are accumulated for the run and flushed at idle. A positive maximum is enforced before the next continuation; reaching it pauses the run with a budget-exhausted event rather than starting more model work.

## Continuation Kernel

One subscriber handles `SessionEvent.Idle` for all workflows. Its shared gate rejects archived sessions, sessions with queued or running Cortex work, sessions without a terminal assistant for the latest reply-required user message, and terminal assistant errors.

Policies run in descending priority:

1. BlueprintLoop (`100`)
2. Lattice (`50`)
3. WorkflowRun (`40`)
4. Light Loop (`25`)

The first policy that handles the idle wins. Per-session, per-policy deduplication keys the decision to the terminal assistant message, so the same terminal response does not generate duplicate wakeups.

BlueprintLoop continues only a `running` bound loop. Lattice enforces its budget, waits during collaborative Blueprint review, starts the current Blueprint in execution phase, or sends a phase continuation. WorkflowRun continues an active seat only while it still owns an entity and has runnable Inbox work. Light Loop sends its task check only when no completion review is pending.

## Invariants

- Workflow instructions are a context projection; stored user text remains unchanged.
- Plan authors a Blueprint and cannot directly execute the requested outcome.
- Blueprint writes occur only in Plan or Lattice.
- Executors request completion; independent reviewer sessions decide it.
- Lattice owns phase transitions and only its own BlueprintLoops can advance its Pathway.
- One shared idle gate prevents continuation while child work or an incomplete/erroring turn is still active.
- A WorkflowRun's pinned Charter version is immutable, and its run snapshot is canonical state.
- WorkflowRun transitions are active-only, serialized, source-checked, and state-before-effect.
- Seat leases have one durable owner; restart-safe handoff uses idempotent materialize-then-remove Inbox consumption, not a live Cortex task.
- Seat sessions inherit the Boss control profile; Charter content cannot elevate execution authority.
- Pause prevents new orchestration work; cancel commits its terminal fence before stopping runtimes.
- Active Boss, seat, and contractor provider calls share one durable pre-provider budget; only the Boss remains conversational across paused and terminal states.

## SuperPlan Storage Substrate

The repository also contains `superplan/` schemas, storage, events, session ownership metadata, and worktree owner types for a graph of nodes and merge waves. No current CLI command, server route, tool registration, or continuation runner exposes SuperPlan as a selectable product workflow. The supported large-goal workflow is Lattice.

Treat SuperPlan fields as an internal persisted substrate that must remain import/export- and migration-safe while present. Do not route new product behavior through it or describe it as equivalent to Plan, BlueprintLoop, or Lattice without first adding an explicit lifecycle and user-facing contract.
