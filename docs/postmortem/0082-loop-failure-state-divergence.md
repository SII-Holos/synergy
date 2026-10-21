# Loop failures disagreed across execution and Composer state

## Executive summary

A terminal provider error ended a BlueprintLoop and released its Session binding, but the Session appeared idle and the Composer still showed an active Blueprint. Execution failure paused only one message-writing path, while Composer row presence mixed Session binding, canonical metadata and draft intent. The correction covers failed-pause recording, a strict Session-binding projection and cleanup of its owned details dialog. The [Loop visibility decision](../decisions/implemented/bug-fix/2026-10-14-visible-loop-status.md) owns the rule and rationale; Loop terminal semantics are unchanged.

## Summary

The provider error was persisted as an assistant error and propagated to the Blueprint start callback. The Loop correctly became `failed`, and its Session binding was removed. The user nevertheless saw a running Blueprint row with a cancellation control. Sending ordinary input could not restore the ended Loop despite that presentation.

## Timeline

- A provider-overload report exposed an idle Session alongside a failed Blueprint run and a running Composer row.
- Read-only canonical queries confirmed the Loop was failed and the Session had neither a pause latch nor a Blueprint binding.
- Real Solid resource probes reproduced stale activity after binding removal and after the component was unmounted while the Loop ended.
- Focused regressions distinguished terminal provider errors from preparation failures, and missing Session records from failed Light Loop cleanup reads.
- The implementation centralizes failed-pause recording at the execution error handler and makes status, slot and control consumers share Blueprint binding resolution.
- Isolated real-model acceptance exposed a related recovery error: new input after a failed pause steered the terminal root and retained its rejected model. The input admission regression extends the existing paused-owner fixture; failed human requests start a new task without reopening the failed execution.
- Product review of PR #1682 rejected retaining an ended Loop as a read-only Composer row and required the same current-attachment rule for BlueprintLoop and Light Loop.
- A further product clarification made Session binding the sole row-visibility criterion, superseding both the pending-selection row exception and hiding on canonical terminal metadata before the Session update.
- Independent review found that clearing a binding could leave an open Loop details dialog empty. The correction requires closing that specific dialog ID rather than an unrelated dialog.

## Root cause

The processor could persist a terminal error and return `stop`. The invocation eventually propagated that record as `SessionTerminalError`, bypassing the separate message completion helper that recorded `paused(reason="failed")`. Message persistence and Session lifecycle were therefore coupled in only one error path. Light Loop used the same execution path, although its own handler correctly wrote a failed terminal record and removed its workflow atomically.

The Composer retained Loop metadata by client and owner across component disposal. Its read marker could suppress a new read after the binding disappeared or the owner remounted. The active slot selector rejected an unbound cached Loop, but the rendered status selector still accepted its non-terminal metadata as activity. Existing tests protected the former selector without asserting the same invariant at the rendered row.

The initial fix removed cancellation from detached or terminal state but still allowed historical metadata and terminal lookups to render a read-only failed, unavailable or resolving row. Its rendered assertion treated that retained failure entry as acceptable. The product requirement concerns the entire attachment row, so removing an action did not resolve the visible defect.

The next correction still allowed locally pending selections to create a row and canonical terminal metadata to remove it before the Session binding cleared. Those expectations did not implement a one-to-one projection of Session binding. The open-details regression also showed that removing the row was insufficient if its dialog remained mounted without content.

Automatic paused-input admission did not distinguish a resumable user interruption from a terminal execution failure. Steering the terminal root retained its model even when the new request selected another model. Failed human input therefore needs a new task, while explicit interruption and passive no-reply input retain their existing behavior.

Light Loop cleanup also treated every failed Session read as a missing Session. Unexpected storage failures must reach the existing workflow-error reporting path rather than silently reporting no cleanup work.

## Guardrails

- `packages/harness/test/session/failure-pause.test.ts` executes the real invocation with a deterministic, non-retryable provider failure and verifies the persisted failed pause after execution releases.
- Existing lifecycle and abort tests retain first-pause, machine-session and cancellation coverage rather than duplicating that matrix in the new invocation test.
- The preparation-failure scenario in `pruning-invoke.test.ts` also queues a subsequent root and verifies that it remains unmaterialized when the current root fails. Terminal errors propagate before post-turn Inbox task consumption, after compaction recovery and abort handling.
- `packages/local-runtime/test/session/absent-owner-input.test.ts` adds failed ordinary input to the existing task-admission fixture and verifies the old execution remains unchanged.
- The Light Loop runtime test extends its existing failure fixture to verify unexpected Session read errors propagate while successful terminal states remain untouched.

### Strict Session-binding projection: verification required

PR #1682's original screenshot and the claim that retaining a failed row was acceptable are superseded. Earlier correction tests that allowed pending-selection rows or hid a row on canonical terminal metadata are also superseded; their results do not establish the strict rule. The following are regression requirements, not a report that strict-rule tests or final UI acceptance have passed:

- Assert no BlueprintLoop or Light Loop row exists without its Session binding, even with a fresh draft selection, cached metadata or historical terminal records. Preserve the selection for the next send without presenting it as bound work.
- Keep the row mounted while the Session binding remains, including paused or interrupted execution, idle intervals and canonical terminal metadata arriving before the Session update. Metadata changes labels and controls only. Remove the entire row when the corresponding Session binding clears; cover both event orders and Light Loop `failed`, `cancelled`, `completed`, `timed_out` and `iteration_exhausted` outcomes.
- Preserve the bound Blueprint row through pending and failed metadata reads, offer Retry and exercise remount and reconnect recovery. Fence stale snapshots and cross-Loop events so they cannot create an unbound row or overwrite another binding.
- Verify zero Composer history scans and Light Loop terminal queries after clearing and owner navigation. Cached or late metadata cannot restore an unbound row after reload or reconnect; the editor node, draft and next-send selection remain intact.
- Open Loop details, clear its binding and assert that the owned dialog closes rather than becoming empty. Close by the captured dialog ID and verify an unrelated open dialog is not dismissed. Check actual mounted rows, dialogs and keyboard interaction at narrow pane widths.

## Lessons

Execution lifecycle must converge independently of which layer persisted its error message. A state invariant tested in a helper does not protect a rendered control that uses another projection. Acceptance must check the user-visible result against the owning product rule; the [visibility decision](../decisions/implemented/bug-fix/2026-10-14-visible-loop-status.md) is the authority for that rule, not an earlier screenshot or a test that encoded the wrong expectation.
