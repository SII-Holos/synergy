# Provider recovery depended on complete stream lifetime

## Executive summary

A healthy recovery stream could block other calls on the same provider connection until their admission budgets expired. Recovery ownership covered the whole response and local cleanup instead of the evidence needed to admit another request. Streaming progress and final request outcome require separate lifetimes.

## Summary

Inspection of provider-recovery timeouts found upstream overload errors and shared connection cooling. That evidence did not establish whether a healthy long probe caused those particular failures. A deterministic reproduction independently established the defect: meaningful response output was delivered, yet another request could not start until the first stream completed. A separate reproduction held local disposal after stream completion and observed the same blocking.

## Timeline

- 2026-10-23: source tracing identified complete-stream and disposal ownership in provider recovery.
- 2026-10-23: three behavioral regressions failed against the original implementation: early admission during a long response, retained midstream failure handling after progress, and admission during held cleanup.
- 2026-10-23: progress-based paced admission passed the regressions; temporary-storage AgentTurn tests verified concurrent call recording for both successful and failed long streams.
- 2026-10-23: held-cleanup AgentTurn tests exposed the recorder's inner settlement delay. Moving outcome observation inside the recorder released admission before executor cleanup for both completed streams and thrown body errors.

## Root cause

The coordinator treated exclusive probe ownership and request-outcome observation as one lease. Clearing recovery required the async iterator to finish and source disposal to resolve. The five-minute budget belonged to each waiting caller and could therefore expire while the probe was making healthy progress. Simply releasing the lease earlier would also disable its later failure reporting. Observing the recorder's outer iterator also delayed provider completion and thrown errors until its internal disposal settled, so moving only the outer disposal boundary was insufficient.

Existing tests exercised acquire, success, failure and release directly, plus stream startup/body failures. None held an actual response open after valid output or held cleanup after completion, so they did not protect streaming admission independence.

## Guardrails

[The recovery decision](../decisions/implemented/bug-fix/2026-10-23-stream-progress-provider-recovery.md) defines paced progress admission, retained body-error observation and failure-revision fencing. Coordinator tests use controlled streams and a virtual clock; AgentTurn tests use a real isolated Runtime and Rollout store. The LLM integration Skill requires both lifetime and accounting checks.

## Lessons

A request can establish enough progress for limited admission while its final outcome remains unknown. Local resource cleanup must still complete, but its duration is not evidence of provider availability. A generic waiting timeout should not be interpreted as proof that the upstream service stayed unavailable throughout the wait.
