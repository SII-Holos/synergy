# Workspace move release outpaced native admission

## Executive summary

WorkspaceMove cancellation could clear its native dispatch marker before an already accepted native hold established its durable claim. That hold then created a claim after release had inspected an empty coordinator ledger. The run rejected because its target reservation was cancelled, leaving the claim retained without dispatch evidence in the move intent.

## Summary

The move intent correctly recorded `nativeRequested` before native admission, but public release did not wait for the accepted run. Inspecting the original native identity before that run settled was insufficient to establish that no claim could appear later.

## Timeline

- Review identified the interval between publishing native dispatch and completion of `SourceHost.hold()`.
- A real coordinator acquire barrier held admission before its native ledger write. Cancellation returned with `nativeRequested=false`; after admission resumed, the run rejected and the actual coordinator retained one durable move claim. The assertion expected zero and failed before production changes.
- Release began draining the original accepted run before native reconciliation. A second behavioral test invoked release from the run's actual source upload callback and reproduced self-waiting, bounded by the fixture's rescue deadline.
- Release now rejects that callback reentry before writing a terminal decision. External cancellation retains native evidence until accepted work and actual claim release complete.

## Root cause

The Runtime job map deduplicated `run()` but did not participate in release. A cancelled move stopped publication through its terminal state while native admission could still be in flight. `releaseNative()` was therefore allowed to observe no claim, clear dispatch and return before the accepted producer could create the native fact.

Simply waiting for the run introduces a separate dependency cycle when a source callback calls public release and waits for it. That entry point must reject explicitly rather than waiting for its own containing operation.

## Guardrails

Release captures the exact accepted job and its Runtime/Store owner before awaiting. It first publishes the permanent terminal decision, preserving native dispatch and reference fields. It drains the accepted promise, then reconciles and releases only the original native identity through the existing provider ledger. Dispatch clears only after actual release succeeds. Cleanup retains the original owner without inheriting the run's cancelled signal.

The execution context identifies only the live accepted run. Public release from that same run rejects before state changes; ordinary external release and the run's private native finalizer remain valid. Joining an existing job also checks its original Runtime/Store owner.

Local Runtime `test/workspace/move.test.ts` uses real coordinator admission and native claims, verifies the retained dispatch after terminal publication, preserves source and target bytes, rejects source-callback reentry, and completes release after the original run signal aborts. Existing lost-commit, cold recovery, namespace and physical-identity cases remain in the same suite.

## Lessons

An accepted native producer must settle before absence in its ledger can certify completion. Terminal business state stops new publication; it does not prove that previously accepted work has ended. See [the decision](../decisions/implemented/bug-fix/2026-11-12-drain-accepted-workspace-moves-before-native-release.md).
