# Decision Record: Recommend blocking waits when command completion gates progress

Status: implemented

## Problem

The process tool recommends a non-blocking query first while synergy-max only asks for meaningful polling intervals. An agent with no independent work can repeatedly request the same progress instead of using the existing blocking wait. Every model round can resend substantial history even when the tool result is short.

The [sealed GLM study](../../../research/context-efficiency/2026-09-23-local24-glm-fault-repair-study.json) records CompCert requests increasing from 113 to 277 and Mailman requests from 53 to 183. These tasks account for 95.6% of additional tokens among the nine tasks both versions passed. Request counts do not establish that every additional request was polling: the observations also include command failures and OOM events.

## Decision

Process, Bash and synergy-max guidance recommends useful independent work while a command runs, otherwise blocking waits when completion gates progress. The process description supplies a 300-second local example for known long builds and installations; existing defaults and the 25-second Synergy Link cap remain authoritative. A still-running result means wait or work elsewhere, not immediately refresh logs or restart the command. Services use readiness checks.

Delayed follow-up uses one existing Agenda timed watch and yields the turn. Visible running subagents retain automatic notifications and the existing watch rejection. APIs, scheduling, process output, history projection, compaction, tool visibility and editing behavior are unchanged.

Free short-process tests verify wait-window expiry and early return on command exit. Model-following behavior is assessed with one new candidate execution each of CompCert and Mailman, retaining GLM 5.3 Flash low and the three-hour solve/verifier budgets. Historical v3.0.22 and candidate results remain separate references; evaluator and resource-contention differences prevent treating this as a contemporaneous controlled comparison.

## Alternatives considered

**Change runtime defaults or add process-triggered Agenda events.** Existing blocking calls and delayed watches already express the required behavior. Changing execution semantics would introduce another variable before prompt guidance is measured.

**Change history management or tool visibility at the same time.** These affect cache behavior and model decisions independently, so they are deferred from this targeted comparison.

**Revert compact file observations.** Oh My Pi also uses snapshot-validated edits and compact model-visible previews, as documented in its [pinned hashline implementation](https://github.com/can1357/oh-my-pi/blob/62bc57be1b03ef0802a33cf7f5f530e534527531/crates/pi-edit/src/session.rs#L364). There is no evidence from the two task totals that reverting file feedback addresses their waiting overhead.

## Consequences

The change is limited to model guidance and preserves existing execution choices. A prompt cannot guarantee compliance; deterministic process tests verify mechanics only. Task reports must retain native tests, request usage, waiting behavior and resource observations, and distinguish reduced redundant work from early failure or a different execution environment. Two single-run observations cannot establish a general local-24 improvement.

The [completed two-task study](../../../research/context-efficiency/2026-09-24-process-waiting-study.md) retains all startup failures and reports native reward 1 with 3/3 tests on both tasks. Its observations support retaining the narrow guidance while exposing a limit: long blocking waits can conceal an installer waiting for input. Historical resource competition, missing historical raw trajectories and changed solve paths limit causal attribution; the report keeps these conditions separate from the implemented decision.
