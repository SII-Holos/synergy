# Decision Record: Compose trusted receipts with native Session continuation

Status: implemented

## Problem

A trusted command receiver must commit its receipt with the native continuation effect. Calling `SessionResume.request()` inside a receiver's SQL transaction would wait for execution and native locks while holding the writer. Recording acceptance afterward would leave a crash window between pause release and the external receipt. A continuation can also outlive the pause it originally observed while waiting for execution to drain.

## Decision

`SessionResume.request()` owns native preparation and rejects an enclosing transaction. It captures the observed pause under the control lock, releases that lock during the cancellable execution drain, then reacquires and revalidates it. Publication rechecks the current pause and archive state inside SQL. Inbox uniqueness is acquired before the Rollout writer rather than inside its transaction.

Trusted callers provide optional transaction-local validation and receipt hooks and a synchronous final commit guard. They run only for a new native continuation. The receipt hook joins Inbox admission, native resume metadata, Rollout reopening, pause release and notifications in the same commit. The final guard checks transient authority at the driver's commit decision and preserves a refusal as an admission error. A supplied actor is copied into the native receipt and any new continuation message. Existing queued input retains its original author. Historical receipts without attribution remain valid; no identity is inferred or backfilled.

Admission failures retain their original cause instead of being classified as corrupted Rollout recording. Cancellation reaches control, execution-drain and Inbox-lock waits and the final commit guard; it does not abort the execution being observed. Duplicate and non-admitting outcomes preserve the existing native API semantics and do not run the hooks.

## Alternatives considered

**Wrap the complete native operation in an outer receipt transaction.** Execution settlement and Rollout writes need that same storage owner, so waiting inside the writer can deadlock.

**Write the external receipt after native continuation.** Response loss or process failure could leave executable input without the durable receipt that authorizes it.

**Implement another continuation path in the organization adapter.** That would duplicate native root selection, recovery, queued input and Rollout reopening rules. The adapter instead joins the existing owner at its commit point.

## Consequences

Real temporary-storage tests cover actor retention, transaction rollback, callback error identity, a newer pause during drain, cancelled waits, commit cancellation and unrelated writes while Inbox uniqueness is occupied. Existing native continuation, restart, attribution, abort, execution-owner and Rollout tests remain applicable. The organization wire integration still owns its signed command validation, ordering and control versions.

The [Session architecture](../../../architecture/session-and-messages.md#one-active-loop) defines the public host seam. The [pause-race postmortem](../../../postmortem/0096-continue-admission-outlived-observed-pause.md) records the reproduced failure.
