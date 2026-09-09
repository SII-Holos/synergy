# Decision Record: Task delegation guidance separates parallelism from task boundaries

Status: implemented

## Problem

The `task` tool description told the primary agent when to delegate and how to manage background results, but not how to shape an assignment. Its opening guidance ("Launch multiple agents concurrently whenever possible") encouraged parallel dispatch without teaching granularity, and nothing covered input readiness, dependencies, write ownership, or handoff composition. The result was inconsistent delegation: omnibus tasks bundling separately decidable goals, mechanical file/step-level fragmentation, or downstream implementation launched before settled decisions existed. The "Parallel implementation and review" example was ambiguous about whether the review examines an existing boundary or the implementation still being produced. The synergy-flash primary prompt treats tool descriptions as authoritative for semantics, so the tool description is the correct place for this guidance; user-authored Memory rules should not have to compensate for it.

## Decision

`packages/harness/src/cortex/tools/task.txt` now teaches parallelism and scoping as separate decisions, in a new "Parallelism and task boundaries" section plus revised usage notes and examples:

- **Parallelism is preserved but conditioned.** Independent tasks launch concurrently when their inputs are ready and write/resource ownership is compatible; the parent continues useful independent work while background tasks run.
- **One assignment = one coherent, independently verifiable deliverable.** A task may include every step needed to produce and verify that deliverable. Bundling separately decidable goals and splitting tightly coupled work by file, step count, or duration are both called out as anti-patterns.
- **Dependencies gate dispatch.** Dependent tasks start after their inputs exist; unrelated ready work is not serialized merely because final integration will be sequential — the parent runs integration and acceptance once inputs are ready.
- **The parent composes the handoff** (settled decisions, evidence, allowed changes, deliverable, verification criteria, escalation conditions) and owns decomposition, integration, and acceptance; the user is never asked to write a task contract.
- **Implementation vs. bounded investigation.** Material design decisions are resolved in the parent before dependent implementation, or dispatched as a clearly bounded investigation; an open-ended planning problem must not be disguised as an implementation task.
- **Examples disambiguate review.** Parallel implementation now shows two independent implementations with settled interfaces, review-of-existing-boundary runs alongside unrelated implementation, and review of new implementation is shown dispatching only after a reviewable artifact exists.

No runtime semantics change: background execution, notifications, result acknowledgment, session reuse, output contracts, and DAG binding are untouched. The polling/notification-discipline literals asserted by `packages/harness/test/agent/task-polling-prompt.test.ts` are preserved verbatim per [the tool-context slimming decision](../simplification/2026-09-06-slim-static-prompt-and-tool-context.md). A review follow-up harmonized the two remaining pre-existing unconditioned-parallelism phrasings — the "Use this when" list entry and the `background=true` default note — with the conditioned language; the prose test locks the amendment with a negative assertion on the retired phrasing.

## Alternatives considered

- **Prompt-only guidance in the synergy/synergy-max base prompts** — rejected: the task tool description is the single authority every delegating agent (including synergy-flash, whose short prompt omits delegation prose) reads at decision time; duplicating it in each primary prompt would drift and add per-session token cost.
- **Schema-level enforcement (per-task limits, required planning model call)** — rejected: the issue explicitly excludes arbitrary limits or an extra planning-model call, and granularity judgment does not reduce to a countable schema field.
- **A separate task-granularity guide or Skill** — rejected: the model-facing semantic belongs beside the tool, which is what the model consults when composing a call; a standalone document would not be loaded at dispatch time.
- **Appending a checklist without revising existing prose** — rejected: redundant "launch many tasks" wording would contradict the conditioned guidance; the old usage-note and example text was revised in place.

## Consequences

Delegating agents get one coherent answer for when to parallelize, how to size an assignment, and what a sufficient handoff contains, at a modest size increase in the task tool description (`task.txt` carries no byte-budget lock). Correctly scoped tasks should reduce rework from premature downstream dispatch and from omnibus or fragmented assignments. Model-facing prose is tested by literal assertion, so a future rewrite that drops a guarantee fails CI rather than silently changing behavior. The remaining risk is inherent to prose guidance: a model may still over- or under-delegate, but the tool description now states the boundary rules the reviewer checks against.
