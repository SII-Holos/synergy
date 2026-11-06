# Decision Record: A BlueprintLoop reaches acceptance only through `blueprint_loop_approve`

Status: implemented

## Problem

On 2026-09-19 four BlueprintLoops from the same batch were merged as if complete while their own records showed otherwise. One loop never reached `completed` at all. In two cases the bound supervisor had explicitly rejected the stop request and the branch was merged anyway; in one case the executor's final message described the work as done while its own `remaining[]` still listed the defect the work had started from as NOT FIXED. A fifth Blueprint in the same batch reported `Run Count: 0` and had never run.

The common shape is that "complete" came from the executor's narration. That narration is generated inside the same session that did the work, by the same context that produced the work, and it is the least independent signal available — while the loop's own persisted state already carries an independent one.

## Decision

A pull request whose intent corresponds to a BlueprintLoop is accepted only when that loop reached `completed` through `blueprint_loop_approve`, and the pull request body states the loop's final status and audit conclusion.

An executor's self-assessment is not acceptance. A loop that stalled in `auditing`, failed, or was rejected without a fresh audit is reported as unaccepted rather than described as complete.

`AGENTS.md` carries the rule in its "Protect Checkouts and Runtimes" section, next to the existing publication rules, and `.synergy/skill/git-guide/SKILL.md` carries the matching step in its "Push and Open a PR" checklist.

This is deliberate prose rather than a CI check. Loop state lives in the note store outside the git tree, so a workflow job cannot read it without new pipeline infrastructure, and adding that infrastructure would turn a process contract into a maintained dependency. The repository's other process conventions outside `decision:check` are prose for the same reason.

The rule does not restate the reviewer contract, it points at it: `docs/architecture/workflows.md` already establishes that the persisted BlueprintLoop transition is the authoritative evidence that the reviewer settled the stop request, and that a prose response or a terminal Cortex task is not an approval.

## Alternatives considered

**Add a CI check that the PR's BlueprintLoop reached `completed`.** Rejected as the first move. It needs a new pipeline capable of reading a store that is not in the tree, and it would make every future loop-dependent PR depend on that infrastructure being available. The prose rule plus the PR checklist is the smallest reversible route, and it can be mechanised later if the rule proves hard to follow.

**Require the loop's status only for changes that touch enforcement or persistence.** Rejected: the failure was not confined to those areas. The batch that motivated this record spans storage, sandbox, desktop power management, and session recovery, and each was independently described as complete.

**Treat a fully green CI run as the acceptance signal in place of the loop status.** Rejected: CI cannot see the loop, and the loops that motivated this record had green CI in at least one case while the branch was missing its central proposition.

## Consequences

A pull request now carries one more obligation: name the loop and its outcome. When a change implements several loops, each one's status is stated rather than summarised as a group, because the failure mode this rule targets is a group described as finished while one member is not.

A green gate is still not self-justifying. A required check can fail for reasons that belong to the runner rather than the change — the local artifact build needs `docker`, and a hosted job can fail before it compiles anything. The companion rule added with this one requires distinguishing the two before treating a red gate as evidence about the code, and re-running until green rather than merging past it. A check that cannot be made green is a blocker to report, not a condition to waive.
