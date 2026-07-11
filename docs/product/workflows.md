# Workflows

Synergy workflows change how a session should continue beyond a single model response. They are durable session modes with explicit completion rules, not prompt labels.

Only one of Plan, Light Loop, or Lattice can be active on a session at a time. BlueprintLoop is the execution lifecycle for a Blueprint and can either be started by the user or owned by a Lattice step.

## Choosing a Workflow

| Need                                                                           | Use           |
| ------------------------------------------------------------------------------ | ------------- |
| Decide what should be done before execution                                    | Plan          |
| Execute an authored Blueprint with independent review                          | BlueprintLoop |
| Keep working on one bounded task until an independent reviewer accepts it      | Light Loop    |
| Decompose a larger goal into an ordered sequence of planned and reviewed steps | Lattice       |

Normal chat remains the right choice when the work does not need a durable outer loop.

## Plan and Blueprints

Plan turns a request into an authored Blueprint. The active agent can inspect context, research, ask blocking questions, and delegate analysis, but it does not carry out the requested outcome. For code work, that means no implementation or project-file edits; for external work, it means no identity-bearing action such as sending or publishing.

A useful Blueprint is decision-complete. It captures the goal, constraints, selected approach, deliverables, acceptance criteria, verification, risks, and relevant exclusions. Decisions that materially change the result should be resolved with the user rather than left for an execution session as `TBD` or an open question.

Blueprints are a specialized kind of Note. They can be read from any workflow, but note tools can create or modify them only while Plan or Lattice is active. Ordinary Notes remain writable outside those workflows.

## BlueprintLoop

BlueprintLoop binds a specific Blueprint version to an execution session. It resolves an execution agent, an audit agent, an optional model, and a run location:

- the current session
- a new session
- a dedicated worktree session

The execution agent reads the full Blueprint and any run-specific start instruction, then continues until it can provide concrete completion evidence. A normal assistant response does not finish the loop. On idle, Synergy wakes a running loop to continue.

When the executor believes the outcome is complete, it requests an audit. Synergy launches a hidden reviewer session, normally using `supervisor`, which inspects the Blueprint, start instruction, execution history, artifacts, workspace state, and verification evidence.

The reviewer has two outcomes:

- approve — mark the loop complete and return the audit summary
- reject — return concrete remaining work and resume execution

Only the recorded audit session can approve or reject that request. The execution session cannot approve itself.

Starting a user-owned BlueprintLoop exits Plan or Light Loop when the session is idle. A Lattice-owned BlueprintLoop is controlled by its Lattice run instead.

## Light Loop

Light Loop is the smaller persistence workflow. It records one task description and wakes the same session whenever the agent becomes idle after a valid terminal response. The agent repeatedly checks the requested deliverables, current work, verification evidence, errors, and edge cases.

Completion is a review request, not a claim. Calling `loop_stop` launches a hidden `lightloop-reviewer` child session and pauses generic continuation while review is pending.

- approval clears the Light Loop workflow and reports the verdict
- rejection records the review attempt, clears the pending stop request, and delivers actionable remaining work so the loop continues

Light Loop does not require an authored Blueprint or a multi-step Pathway. Use it for one task whose scope is already sufficiently clear.

## Lattice and the Pathway

Lattice coordinates a larger goal as an ordered Pathway. Every step has an objective, acceptance criteria, assumptions, status, and an associated Blueprint. Each Blueprint is executed and independently audited through BlueprintLoop before the Pathway advances.

A Lattice run moves through five phases:

1. `initial_planning` — investigate the goal and create the ordered Pathway
2. `step_blueprinting` — author and bind a Blueprint for the current step
3. `blueprint_review` — in collaborative mode, wait for the user to review or refine that Blueprint
4. `blueprint_execution` — run the step's BlueprintLoop
5. `result_analysis` — record the result and decide how the remaining Pathway should change

In `auto` mode, Synergy starts the bound Blueprint when the session next becomes idle. In `collaborative` mode, it pauses at Blueprint review until the user continues, optionally with a run-specific instruction.

The Pathway is adaptive. Non-terminal future steps can be reordered, refined, added, or removed as results emerge. Completed, failed, and cancelled steps remain immutable history, and a running step cannot be silently removed or redefined.

An optional model-call budget pauses the run when exhausted. Runs can also be paused, resumed, restarted, or cancelled explicitly. Pausing makes the current run inert; resuming wakes the shared continuation mechanism again.

## Shared Continuation

BlueprintLoop, Lattice, and Light Loop share one continuation kernel. It acts only when:

- the session exists and is not archived
- no Cortex child task for the session is queued or running
- the latest reply-required user task has a terminal assistant response without an error

If more than one policy could react, the priority is BlueprintLoop, then Lattice, then Light Loop. A terminal response is consumed at most once by each policy, preventing duplicate continuation messages.

This ordering gives the innermost execution loop control while a Lattice step is running, then returns control to the Pathway after the BlueprintLoop reaches a reviewed terminal state.
