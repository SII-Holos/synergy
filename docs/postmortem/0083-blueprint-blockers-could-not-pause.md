# Blueprint blockers did not pause execution

## Executive summary

An executor reporting an authorization blocker could be repeatedly resumed by a running BlueprintLoop. The completion tool had no pause action, and the general Session control tool required the very execution lease it was meant to stop or unblock. The correction provides an explicit pause action on the existing Blueprint tool and separates control operations from execution admission.

## Summary

Issue #901 reported a long-running repetition of blocker replies. On baseline `8c98fdead`, an isolated full Session/HTTP-model fixture reproduced three continuation messages after three identical authorization-blocked replies. This was a bounded reproduction of the host mechanism, not a replay of the reported multi-hour incident.

The controls mattered: a genuinely pending question prevented continuation, and an external Session stop persisted a pause that rejected even a forced drive. An accelerated one-second question timeout released its wait and allowed continuation again. A real self-abort tool call failed with `busy` because it requested a second lease for its own executing Session.

## Timeline

- Compared blocker text, pending questions, question expiration, self-abort and external stop through real Session and tool owners, replacing only inference with a local HTTP fixture.
- Established failing tests for lease-based control admission and for an explicit Blueprint pause action.
- Added pause using the existing Session latch and persistence hook; preserved independent review as the completion path.
- Found and reproduced two additional integration gaps: simultaneous pause and review could both be accepted, and a result-hook failure could prevent the persistence hook while allowing another model turn despite a durable pause.
- Verified conflicting-action exclusion, the per-turn pause check and concurrent user input taking over while the old tool result was settling.
- Independent review exposed two combinations missed by the first fixtures: a failed pause receipt left a same-batch question waiting indefinitely, and a cancelled queued self-abort could acquire the control lock after user takeover and pause the new input. Both were reproduced by the executor, then corrected with failed-settlement interruption and cancellable control admission.
- Ran isolated real-provider acceptance with DeepSeek: no unauthorized file write, a saved successful pause receipt, pause retained across Runtime reopen without another model turn, explicit user authorization followed by verified file output, and independent supervisor approval.

## Root cause

The continuation mechanism reads authoritative workflow and Session state, not the meaning of an assistant reply. Blocker prose left the Loop running and the Session unpaused. Requesting independent review was not a substitute because it would claim an outcome was ready for acceptance.

General Session control wrapped abort, question replies and permission replies in `SessionManager.run`. An occupied target could not grant the new lease, so these operations failed before reaching their existing control handlers. Empty targets could also acquire and release an unnecessary lease, publishing unrelated lifecycle effects.

Self-stop must preserve ordering. Signalling from the execution callback can cancel its own result; waiting for full abort inside `afterPersist` can deadlock with user input holding the control lock while awaiting that same lease. Persisting the result and then synchronously signalling the existing owner avoids both failures. The durable pause also needs a model-loop check because plugin/result processing can fail before the persistence hook runs.

A model-loop check alone cannot help while the processor is still waiting for a parallel tool batch. An errored result must also drain an already-paused original execution, including its same-batch questions. Conversely, cancelling a tool's outer wait does not cancel an implementation already queued on a separate lock. The abort operation must carry that caller signal into control-lock admission or it can apply a stale stop after a new input clears the pause.

## Guardrails

- [Blueprint stop tests](../../packages/blueprint/test/tool/standalone-stop.test.ts) cover pause persistence, original-lease signalling, control-lock independence, conflicting actions, first-pause preservation, invalid callers and machine-session rejection.
- [Full Session regressions](../../packages/presets/test/session/blueprint-blocker-reproduction.test.ts) cover real HTTP model/tool execution, pause/Continue, first-prompt delivery, self-abort, hook failure and concurrent user takeover.
- [Session control lease tests](../../packages/workbench/test/tool/session-control-leases.test.ts) exercise real pending inputs, busy and idle targets, target Scope binding and unchanged exclusive-operation requirements.
- Tool presentation tests retain review defaults, distinguish explicit pause, preserve the successful receipt and localize neutral ID-only activity labels.
- The [decision record](../decisions/implemented/bug-fix/2026-10-21-blueprint-blocker-pause-and-control-signals.md) preserves the single pause owner and rejected alternatives; the tool-development Skill requires persistence-before-self-stop and failure/concurrency tests.

## Lessons

An expressed blocker and a durable control action are different observations. Existing wait and pause paths must be tested before concluding that a product lacks a stop mechanism. Interruption and pending-input replies must not require becoming a second executor.

The new action pauses interactive execution, not every descendant or machine-owned workflow. It does not infer intent from prose, alter question timeout policy or guarantee that a model always selects the correct action. The real-provider acceptance is a single-path behavioral check, not a claim of universal model quality or reproduction of the original incident duration.
