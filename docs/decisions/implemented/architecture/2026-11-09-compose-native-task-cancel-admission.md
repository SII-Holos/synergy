# Decision Record: Compose native task cancellation admission

Status: implemented

## Problem

A trusted host must prove that a task cancellation was received without claiming its processes have already exited. Recording a receipt after cancellation leaves a crash window, while wrapping physical drainage in the host's SQL transaction violates Rollout writer ownership and performs irreversible effects before commit.

## Decision

`RolloutLifecycle.cancel()` accepts optional admission validation, receipt and synchronous final commit-guard hooks. Its existing Rollout writers publish the cancellation intent, matching Inbox removal and host receipt in one transaction. An unopened task gets its native cancelled admission record in that same commit. A run appearing during preparation is re-read under the Rollout writer, including an interrupted run. A terminal or already-requested run can publish a host receipt without rewriting prior evidence.

Hooks receive a detached native record and preserve their original failures through Rollout error classification. Hook refusal, lost admission signal or final guard failure rolls back the journal, queue and receipt before any execution signal. The operation rejects an enclosing SQL transaction. Hosts retain the Session control lock across this operation when serializing cancellation with continuation or other conflicting controls.

After successful admission, the existing root-scoped cancellation drains execution, children, detached work and processes. Admission cancellation no longer applies after commit. A drainage error cannot erase reception or imply physical completion. Existing native recovery settles interrupted records using the retained cancel intent; it does not replay external effects. Logical request deduplication and actor receipts remain the trusted host's responsibility.

## Alternatives considered

**Store a receipt after all work ends.** Execution can be cancelled before the receipt lands, leaving a retry unable to distinguish prior reception from a new intent.

**Wrap the whole cancellation in the caller's transaction.** Rollout publication owns its journal lock and commit, and physical signals and process drainage cannot run in a retryable SQL body.

**Create another cancellation queue.** The native Run already records cancellation intent and recovery owns interrupted execution. A second queue would duplicate lifecycle authority and add another replay policy.

## Consequences

Hosts can compose the established task-cancel entry with durable command reception while retaining independent physical outcomes. No persisted schema, migration or public HTTP response changes. The host must serialize controls and reconcile its receipt after uncertainty; acceptance is not permission to infer that an external process or side effect completed.

Real storage tests cover refused validation/receipt/commit guards, cancellation before and after reception, active execution ordering, unrelated roots, unopened and concurrent interrupted runs, terminal no-ops, and retained reception after failed drainage and native recovery. Existing Inbox and Rollout regressions retain their lifecycle coverage. The [Session controls](../../../architecture/session-and-messages.md#one-active-loop) document defines the owning API.
