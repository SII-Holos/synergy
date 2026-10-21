# Loop failures disagreed across execution and Composer state

## Executive summary

A terminal provider error ended a BlueprintLoop and released its Session binding, but the Session appeared idle and the Composer still showed an active Blueprint. Execution failure paused only one message-writing path, while the Composer's activity controls and status row used different binding rules. Shared execution failure handling and shared Blueprint binding resolution restore those invariants without changing Loop terminal semantics.

## Summary

The provider error was persisted as an assistant error and propagated to the Blueprint start callback. The Loop correctly became `failed`, and its Session binding was removed. The user nevertheless saw a running Blueprint row with a cancellation control. Sending ordinary input could not restore the ended Loop despite that presentation.

## Timeline

- A provider-overload report exposed an idle Session alongside a failed Blueprint run and a running Composer row.
- Read-only canonical queries confirmed the Loop was failed and the Session had neither a pause latch nor a Blueprint binding.
- Real Solid resource probes reproduced stale activity after binding removal and after the component was unmounted while the Loop ended.
- Focused regressions distinguished terminal provider errors from preparation failures, and missing Session records from failed Light Loop cleanup reads.
- The implementation centralizes failed-pause recording at the execution error handler and makes status, slot and control consumers share Blueprint binding resolution.
- Isolated real-model acceptance exposed a related recovery error: new input after a failed pause steered the terminal root and retained its rejected model. The input admission regression extends the existing paused-owner fixture; failed human requests start a new task without reopening the failed execution.

## Root cause

The processor could persist a terminal error and return `stop`. The invocation eventually propagated that record as `SessionTerminalError`, bypassing the separate message completion helper that recorded `paused(reason="failed")`. Message persistence and Session lifecycle were therefore coupled in only one error path. Light Loop used the same execution path, although its own handler correctly wrote a failed terminal record and removed its workflow atomically.

The Composer retained Loop metadata by client and owner across component disposal. Its read marker could suppress a new read after the binding disappeared or the owner remounted. The active slot selector rejected an unbound cached Loop, but the rendered status selector still accepted its non-terminal metadata as activity. Existing tests protected the former selector without asserting the same invariant at the rendered row.

Automatic paused-input admission did not distinguish a resumable user interruption from a terminal execution failure. Steering the terminal root retained its model even when the new request selected another model. Failed human input therefore needs a new task, while explicit interruption and passive no-reply input retain their existing behavior.

Light Loop cleanup also treated every failed Session read as a missing Session. Unexpected storage failures must reach the existing workflow-error reporting path rather than silently reporting no cleanup work.

## Guardrails

- `packages/harness/test/session/failure-pause.test.ts` executes the real invocation with a deterministic, non-retryable provider failure and verifies the persisted failed pause after execution releases.
- Existing lifecycle and abort tests retain first-pause, machine-session and cancellation coverage rather than duplicating that matrix in the new invocation test.
- The preparation-failure scenario in `pruning-invoke.test.ts` also queues a subsequent root and verifies that it remains unmaterialized when the current root fails. Terminal errors propagate before post-turn Inbox task consumption, after compaction recovery and abort handling.
- `packages/local-runtime/test/session/absent-owner-input.test.ts` adds failed ordinary input to the existing task-admission fixture and verifies the old execution remains unchanged.
- The Light Loop runtime test extends its existing failure fixture to verify unexpected Session read errors propagate while successful terminal states remain untouched.
- Composer selector and resource tests cover detached cached activity, owner remount, binding replacement, interrupted reads beside an older terminal cache, stale asynchronous responses, older cross-Loop events and reusable confirmed terminal results.
- Rendered controls verify that detached or terminal rows cannot cancel a Loop and that new pending intent and the editor draft survive status changes.

## Lessons

Execution lifecycle must converge independently of which layer persisted its error message. Cached workflow metadata describes history, not current occupancy. A state invariant tested in a helper does not protect a rendered control that uses another projection; every consumer must share the same activity resolution.
