# Decision Record: Proportional planning and loop completion

Status: implemented

## Problem

Repeated planning instructions, fixed document sections and mandatory independent review for every Light Loop impose coordination cost on small tasks. Recreating Blueprint reviewers after rejection discards useful audit context. Structured completion fields duplicate facts that a concise natural-language report can express.

## Decision

Plan uses one shared prompt and natural Markdown with task-proportional detail. It preserves complete requirements, boundaries, important decisions and acceptance evidence. Material ambiguity can be clarified when discovered; routine implementation choices stay with the executor. The requested outcome verification is planned for execution, while planning probes resolve only material feasibility uncertainty.

Light Loop uses executor self-check and `loop_stop({summary})` for direct completion. Its active state contains the goal, optional plugin owner and deadline. The existing terminal record and hook delivery path remain authoritative; terminal publication and workflow removal share a transaction. Goal changes invalidate an in-flight completion snapshot. Legacy pending reviews migrate to an interactive pause or an explicit unattended failure, retaining the goal and history.

BlueprintLoop retains independent final acceptance. Stop and verdict tools each take one prose field. Existing session, task and stop-message identities authorize reviewer actions. Rework reuses the reviewer session after the prior turn finishes, with authority withdrawn during execution. Audits reuse valid evidence and check changes before confirming the full original goal. Missing verdict recovery remains bounded; direct completion cannot bypass approval. Lattice still authorizes only its current Step.

Plugin API 4 and IPC protocol 5 accept optional deprecated `reviewAgent`, `reviewTools` and `budget.maxIterations` fields and ignore them at the Host entry point. Execution permissions, generation ownership and runtime limits remain enforced. Historical statuses and transcript renderers remain readable. This intentionally changes the completion meaning for Light Loop consumers: independent acceptance uses BlueprintLoop.

Successful completion hides the Light Loop and BlueprintLoop composer rows directly from the authoritative status, without a dismissal flag or storage mutation. History-only lookups load silently, so navigation and reload do not recreate an active-looking row. Completion evidence remains in the conversation and Blueprint Note; unsuccessful outcomes keep their explanation and recovery controls.

Cancellation is checked again after asynchronous reviewer-binding reads and Agenda guards, before committing a review verdict or stop request. An interrupted turn must not settle a workflow.

Agenda bridges provide cleanup instructions on actual wakeups and enforce session-local completion guards; they do not add a standing cleanup reminder. Execution reuses complete requirements already in context and reads missing or changed content. Delegation keeps one owner per coupled edit path, and final verification follows settled writers. Local verification runs its existing static gates before selected tests, avoiding test reruns caused by late static failures. Completion and review summaries reference detailed evidence without requiring another schema or report copy.

## Alternatives considered

Mandatory review on every task preserves a uniform workflow but keeps the latency and duplicated state this change removes. Configurable review modes, risk scores and requirement registries add fields and execution paths; they are unnecessary for selecting between existing Light Loop and BlueprintLoop. Rejecting obsolete plugin inputs breaks callers without improving the current execution path. Removing Blueprint review would weaken independent acceptance for long tasks.

## Consequences

Small tasks can finish without launching a reviewer. Long tasks retain durable goals, full-goal checks and independent Blueprint acceptance without a new orchestration framework. Light Loop completion is an executor judgment, so it does not provide independent review. Retained evidence can become stale; reviewers must repeat checks affected by changes. Compatibility is limited to accepting obsolete inputs and reading history, with no legacy runtime branch to maintain.
