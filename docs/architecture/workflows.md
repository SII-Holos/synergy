# Workflow Runtime

This document defines session-local workflow execution. A session's workflow field stores one active kind—`plan`, `lightloop`, or `lattice`—while BlueprintLoop keeps a separate execution record bound to that session. This contract does not define cross-session orchestration.

These workflows provide durable orchestration above the ordinary serial LLM loop.

## Mutual Exclusion and Ownership

Enabling or switching any workflow, plus ordinary workflow disabling, requires an idle session. Light Loop has dedicated instruction-update and cancellation operations: its instructions can change only while no completion review is pending, and cancellation aborts active session work plus descendant reviewer tasks before clearing the workflow. Plan and Light Loop cannot be enabled while another workflow or active BlueprintLoop exists. Lattice can resume its own run but refuses a live user-owned BlueprintLoop.

A user-owned BlueprintLoop can replace Plan or Light Loop after the session is idle. It cannot replace an active Lattice workflow. A BlueprintLoop with `source: "lattice"` is valid only while Lattice owns the session.

Disabling Lattice first pauses the run, then cancels any active Lattice-owned BlueprintLoop so terminal loop events cannot advance an inactive Pathway.

## User-Message Projection

Workflow instructions are projected into model context without rewriting the stored user text. Root, user-origin messages receive compact workflow metadata when they are created. During context assembly, the first user text part is wrapped with the agent-specific Plan, Lattice, or Light Loop contract.

System control messages, non-root messages, and messages from continuation sources are not wrapped again. This keeps the durable transcript faithful to what the user wrote while making the active contract explicit to the model.

## Plan Enforcement

Plan prompts instruct the agent to research and author a decision-complete Blueprint instead of executing the result. A finalized Blueprint uses eight shared semantic sections and selects one material implementation route: materially different owners, architectures, data flows, compatibility strategies, domain methods, artifact shapes, and user-visible behaviors must be resolved from evidence, established conventions, or a blocking user decision. Incidental execution mechanics remain delegated to the executor. Tool exposure and execution policy enforce the read-only project boundary in addition to the prompt.

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

The execution session is marked with `loopRole: "execution"`; the visible Cortex review child is marked with `loopRole: "audit"`. Only the execution session can call `blueprint_loop_stop`, and only the recorded audit session can approve or reject.

`blueprint_loop_stop` records a durable stop intent during the executor turn. After the execution-session lease is released, the BlueprintLoop continuation prepares the visible Cortex reviewer, binds its task and audit session IDs while moving the loop to `auditing`, then starts the reviewer. The reviewer appears in the execution session's Subagent Dock, while ordinary Cortex completion notification stays disabled because approve or reject owns workflow result delivery. Rejection increments the audit attempt count; when the incremented count reaches `maxIterations`, the loop fails with `iteration_exhausted` instead of returning to execution.

For user-owned loops, approval returns a completion notice to the execution session. For Lattice-owned loops, approval tells the session to analyze and record the step result instead of stopping at a user-facing summary.

## Light Loop State

Light Loop stores its instructions directly on the session workflow. A stop request first records the executor's summary, claimed completed work, evidence, limitations, and request identity without reviewer IDs.

After the execution-session lease is released, the Light Loop continuation prepares a visible Cortex reviewer, durably binds its task and session IDs to the stop request, then starts it. The reviewer appears in the execution session's Subagent Dock, while ordinary Cortex completion notification stays disabled because approve or reject owns workflow result delivery. Repeated `loop_stop` calls are idempotent while either the unbound stop intent or bound review is pending.

The `lightloop-reviewer` has exclusive access to `light_loop_approve` and `light_loop_reject` for its parent stop request. Approval clears the workflow even though the review child is running. Rejection clears `stopRequest`, records attempt metadata, and delivers the reason, remaining items, and concrete instructions to the execution session. As with BlueprintLoop, a rejection whose incremented count reaches `maxIterations` terminates with `iteration_exhausted`.
For plugin-owned Light Loops, every terminal path persists the terminal status before invoking the owning generation's `lightloop.after` observer. The workflow records `terminalHookDeliveredAt` only when the generation matches, at least one handler exists, and every matching handler completes successfully. A mismatch, missing handler, or handler failure leaves the marker unset and persists `terminalHookError`; repeated terminalization and plugin startup reconciliation retry the delivery. A per-session delivery lock prevents concurrent terminal calls from invoking an already acknowledged hook.
The active instructions may be updated without restarting the workflow; the next model step re-reads the session and uses the revised instructions. The product surface permits editing only while the session is idle, and the service rejects updates while a stop request is under review. Light Loop cancellation is idempotent and uses the shared session-abort path to stop the active turn and descendant Cortex review tasks before conditionally clearing the workflow.

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

## Continuation Drive

`SessionDrive` is the single session-level arbitration entry point. Cortex completion, Agenda delivery or wait release, Lattice resume, and `SessionManager.release` all request the drive instead of delivering workflow continuations independently. Requests are serialized per session: each arbitration is queued after the previous request settles, so reentrant requests are not lost and processing wakes happen outside the tracked arbitration promise.

The driver does nothing while the session owns an active loop lease. Once idle, it first honors runnable durable Inbox work. Only when the Inbox has no runnable item does it ask the ContinuationKernel for a workflow proposal. The winning proposal is persisted with `SessionInbox.deliverUnique` under a stable delivery key, committed to policy deduplication, and then scheduled through the normal session wake path.

The shared continuation gate rejects archived sessions, sessions with an explicit continuation wait, sessions without a terminal assistant for the latest reply-required user message, and terminal assistant errors. `ContinuationWait` currently derives waits from queued or running Cortex child sessions and one-shot Agenda watches that own the next wake.

Policies run in descending priority:

1. BlueprintLoop (`100`)
2. Lattice (`50`)
3. Light Loop (`25`)

The first policy that returns a proposal wins. Per-session, per-policy deduplication keys the decision to the terminal assistant message, while Inbox delivery keys make persistence idempotent across concurrent requests and restart recovery.

BlueprintLoop normally continues a `running` bound loop, but an unbound stop intent is handled first by preparing, binding, and starting its reviewer. Lattice enforces its budget, waits during collaborative Blueprint review, starts the current Blueprint in execution phase, or proposes a phase continuation. Light Loop similarly handles an unbound stop intent before proposing its ordinary task check.

### Agenda Wait Ownership

Only wake-capable Agenda items with `autoDone === true` are continuation waits. These one-shot watch-style items deliver directly to their origin session and complete after that delivery, so ordinary workflow continuation must not race their promised wake. Ordinary recurring or manually managed Agenda schedules remain wakeable but do not suppress workflow continuation merely because they are active.

The wait check deliberately ignores `nextRunAt`, so an overdue or just-fired one-shot watch remains a wait while its status is still `active` or `pending`. Cancelling, pausing, removing, making the item non-waking or silent, or automatically completing it releases the wait. `AgendaSessionWakeup.resumeIfReleased` then requests `SessionDrive`; for automatic completion, that request is deliberately deferred until after the Agenda result is persisted to the Inbox.

When Agenda delivery wakes an active Light Loop or running BlueprintLoop execution session, the delivery appends system-origin cleanup guidance: it lists remaining one-shot waits with their `agenda_cancel` commands, exposes `agenda_cancel`, `agenda_list`, and the correct stop tool, and instructs the loop to cancel those waits before requesting review.

`loop_stop` and `blueprint_loop_stop` call `AgendaSessionWakeup.assertClear` to reject the request while any one-shot wait remains, showing the cancellation commands in the error message.
Pending stop intents suppress Agenda wake guidance and are re-driven through `SessionDrive` during startup recovery. A reviewer task interrupted after its durable binding is replaced from the surviving parent stop intent rather than treated as completed review work.

## Invariants

- Workflow instructions are a context projection; stored user text remains unchanged.
- Plan authors a Blueprint and cannot directly execute the requested outcome.
- Blueprint writes occur only in Plan or Lattice.
- Executors request completion; independent reviewer sessions decide it.
- Lattice owns phase transitions and only its own BlueprintLoops can advance its Pathway.
- One shared drive serializes Inbox work and workflow proposals, and the shared gate prevents continuation while child work, an incomplete or erroring turn, or a one-shot Agenda wait is still active.

## SuperPlan Storage Substrate

The repository also contains `superplan/` schemas, storage, events, session ownership metadata, and worktree owner types for a graph of nodes and merge waves. No current CLI command, server route, tool registration, or continuation runner exposes SuperPlan as a selectable product workflow. The supported large-goal workflow is Lattice.

Treat SuperPlan fields as an internal persisted substrate that must remain import/export- and migration-safe while present. Do not route new product behavior through it or describe it as equivalent to Plan, BlueprintLoop, or Lattice without first adding an explicit lifecycle and user-facing contract.
