# Cortex Delegation

Cortex is Synergy's child-session execution layer. It turns a delegated unit of work into a separately observable session with its own prompt, agent, model, progress, output contract, cancellation tree, and optional worktree.

Delegation is implemented as a tree of sessions, rather than as hidden work inside one message history. A parent session assigns a bounded task, Cortex creates or reuses a child session to perform it, and the child returns an explicit result while keeping its own history.

## Task and Session Identity

A Cortex task records:

- its task ID and child session ID
- the parent session and parent message that launched it
- a description and full prompt
- the selected agent, execution role, category, and optional DAG node
- status and live progress
- visibility and notification behavior
- output mode and resolved output

Task status moves through `queued`, `running`, and one terminal state: `completed`, `error`, `cancelled`, or `interrupted`. A Task is created only when it has entered the Cortex queue, so there is no separate `pending` lifecycle state. `interrupted` means durable metadata says work was active, but no live runtime survived restart; it is distinct from an execution error.

The child session is the durable record. The in-memory task entry coordinates live execution and is eventually evicted; the child session retains its Cortex metadata, messages, model, terminal status, and output.

Plugin-owned tasks additionally persist plugin ID, plugin generation, Scope ID, and a plugin-defined correlation ID. These fields let a plugin resume its own domain workflow without treating the in-memory Cortex map as durable state.

## Launch and Concurrency

The `task` tool validates that the requested subagent is visible to the parent and permitted by its delegation policy. Cortex then creates a child session in the parent's `Scope` and workspace, or reuses an idle compatible child when reuse is requested. If a new worktree is requested, Cortex creates one for the child; a child of an existing worktree inherits that worktree instead of nesting another.

Tasks are admitted through both per-agent and process-global concurrency limits. Each concurrency key allows at most eight running tasks. The global maximum defaults to eight and can be set with the global `cortex.maxConcurrentTasks` configuration or overridden for the process by `SYNERGY_CORTEX_GLOBAL_CONCURRENCY`. Lowering the maximum does not cancel running tasks; it queues new work until capacity is available, while raising it wakes eligible queued work.

Memory pressure produces a recommended global maximum of four under elevated pressure or two under critical pressure. This recommendation is observable but advisory: it never changes or overrides the configured, environment-provided, or default effective maximum. The read-only `cortex.concurrency` API reports configured, environment, effective, recommended, recommendation reason, source, per-agent, running, and queued values.

An explicit task model wins. Otherwise Cortex resolves the selected agent's available model, with the parent's model available as the normal fallback path. The resolved model is persisted on the child session.

## Execution Roles and Tool Boundaries

The ordinary role is `delegated_subagent`. It is intentionally narrower than a primary session:

- permission questions are denied rather than routed back interactively
- task delegation and task inspection tools are removed
- DAG mutation tools are removed
- configured primary-only tools are removed

This keeps a delegated task bounded and prevents accidental recursive orchestration. Hidden internal reviewers can be given an explicit `delegationGroup` so they can call selected specialists while remaining hidden and unavailable as direct user targets.

The child still uses the normal session loop, control-profile resolution, capability gate, permission rules, and sandbox pipeline.

## Foreground and Background Tasks

A background task returns its identity immediately and continues independently. A foreground task waits for the child result for up to 300 seconds. If the wait expires, the task keeps running in the background rather than being cancelled.

Completion is event-driven. The parent does not need to poll `task_output` in a loop. When a synchronous waiter exists, Cortex resolves that waiter directly. Otherwise, a visible task can notify the parent session when the parent is available; hidden reviewer tasks normally suppress parent-facing task events and notifications.

When the parent explicitly reads a terminal task through `task_output`, the persisted tool result satisfies any deferred completion notification for that task. Reading live progress does not consume the future terminal notification.

## Progress

Cortex observes the child session while it runs. Progress includes:

- the latest textual activity
- current and recent tool calls with their states
- elapsed time and update time

Recent tool history is bounded, and progress events are throttled to avoid turning streaming activity into excessive durable or frontend updates. Progress is observability, not a separate execution log; the child message history remains authoritative.

## Output Contracts

The launcher selects one of three output modes:

- `summary` — the default; returns a compact trajectory summary for internal agents, or bounded assistant text for external agents
- `final_response` — returns the final assistant response without trajectory summarization
- `structured` — requires a JSON Schema object and returns validated structured data

Structured output is implemented through an ephemeral result tool and JSON Schema validation. The caller can permit zero to three repair turns when a result does not validate. External agents do not support structured Cortex output.

Large external-agent outputs are bounded while preserving useful head and tail content. Output normalization is part of task completion and is stored with the child session.

## Delivery to the Parent

Parent delivery and child persistence are separate:

1. the child session reaches a terminal state
2. Cortex resolves and persists the configured output
3. a foreground waiter receives it directly, or an eligible parent notification is emitted
4. a linked DAG node is updated and may be auto-promoted
5. temporary child-worktree resources are cleaned up when appropriate

A running parent is not interrupted with a normal completion notice in the middle of its turn. Callers that need a direct result should await the task; orchestration features can bind the task to a DAG node or use their own continuation trigger.

Plugin Host delegation is always handle-based: `start()` returns immediately, while `get()` and the `cortex.task.after` observer expose completion. At Synergy startup, durable child Sessions left in queued/running state are changed to `interrupted` and emit the same observer so plugin control planes can make an explicit recovery decision.

## Cancellation and Retention

Cancelling a task traverses its descendant task tree, aborts active work, releases concurrency slots, records terminal state, and cleans up owned worktree resources. Cancellation does not erase the child session.

Visible terminal tasks keep their live task record long enough for clients to observe completion, then the in-memory entry is removed. The durable child session remains available through normal session navigation and inspection.

## Invariants

- Delegation creates a child session; it does not splice child messages into the parent history.
- Parent and child retain an explicit hierarchy through `parentID` and Cortex metadata.
- An ordinary delegated subagent cannot recursively delegate or ask the user for permission.
- Backgrounding changes who waits; it does not change the task's execution or persistence.
- Output mode is an explicit contract, not a best-effort prompt convention.
- Cancellation covers descendant tasks and runtime resources without deleting durable history.
