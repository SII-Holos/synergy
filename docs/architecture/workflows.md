# Workflow Runtime

This document defines session-local workflow execution. A session's workflow field stores one active kind—`plan`, `lightloop`, or `lattice`—while BlueprintLoop keeps a separate execution record bound to that session. This contract does not define cross-session orchestration.

These workflows provide durable orchestration above the ordinary serial LLM loop.

## Mutual Exclusion and Ownership

Workflow changes require an idle session. Plan and Light Loop cannot be enabled while another workflow or active BlueprintLoop exists. Lattice can resume its own run but refuses a live user-owned BlueprintLoop.

A user-owned BlueprintLoop can replace Plan or Light Loop after the session is idle. It cannot replace an active Lattice workflow. A BlueprintLoop with `source: "lattice"` is valid only while Lattice owns the session.

Disabling Lattice first pauses the run, then cancels any active Lattice-owned BlueprintLoop so terminal loop events cannot advance an inactive Pathway.

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

One subscriber handles `SessionEvent.Idle` for all workflows. Its shared gate rejects archived sessions, sessions with queued or running Cortex work, sessions without a terminal assistant for the latest reply-required user message, terminal assistant errors, and sessions where any active or pending Agenda item for that session has `wake !== false` and `silent !== true`.

Policies run in descending priority:

1. BlueprintLoop (`100`)
2. Lattice (`50`)
3. Light Loop (`25`)

The first policy that handles the idle wins. Per-session, per-policy deduplication keys the decision to the terminal assistant message, so the same terminal response does not generate duplicate wakeups.

BlueprintLoop continues only a `running` bound loop. Lattice enforces its budget, waits during collaborative Blueprint review, starts the current Blueprint in execution phase, or sends a phase continuation. Light Loop sends its task check only when no completion review is pending.

### Agenda Wake Ownership

Agenda items that can wake their owning session (`wake !== false`, `silent !== true`, status `active` or `pending`, with an `origin.sessionID`) temporarily suppress the shared continuation gate. While any such blocker exists, Agenda owns the wake cadence: ordinary Light Loop, BlueprintLoop, and Lattice continuation policies do not fire.

The blocker check deliberately ignores `nextRunAt`, so an overdue or just-fired item remains a blocker while its status is still `active` or `pending`. Cancelling, pausing, removing, making the item non-waking or silent, or automatically completing it releases the blocker. `AgendaSessionWakeup.resumeIfReleased` then kicks the ContinuationKernel; for automatic completion, that kick is deliberately deferred until after the Agenda result is delivered.

When Agenda delivery wakes an active Light Loop or running BlueprintLoop execution session, the delivery appends system-origin cleanup guidance: it lists remaining blockers with their `agenda_cancel` commands, exposes `agenda_cancel`, `agenda_list`, and the correct stop tool, and instructs the loop to cancel Agenda items before requesting stop.

`loop_stop` and `blueprint_loop_stop` call `AgendaSessionWakeup.assertClear` to reject the request while any blocker remains, showing the cancellation commands in the error message.

## Invariants

- Workflow instructions are a context projection; stored user text remains unchanged.
- Plan authors a Blueprint and cannot directly execute the requested outcome.
- Blueprint writes occur only in Plan or Lattice.
- Executors request completion; independent reviewer sessions decide it.
- Lattice owns phase transitions and only its own BlueprintLoops can advance its Pathway.
- One shared idle gate prevents continuation while child work, an incomplete/erroring turn, or wake-capable Agenda items are still active.

## SuperPlan Storage Substrate

The repository also contains `superplan/` schemas, storage, events, session ownership metadata, and worktree owner types for a graph of nodes and merge waves. No current CLI command, server route, tool registration, or continuation runner exposes SuperPlan as a selectable product workflow. The supported large-goal workflow is Lattice.

Treat SuperPlan fields as an internal persisted substrate that must remain import/export- and migration-safe while present. Do not route new product behavior through it or describe it as equivalent to Plan, BlueprintLoop, or Lattice without first adding an explicit lifecycle and user-facing contract.
