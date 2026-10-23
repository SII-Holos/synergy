# Decision Record: Durable Session Continue admission

Status: implemented

## Problem

A failed model attempt can leave a resumable task with a terminal error message. Clearing the Session pause and asking the ordinary continuation gate to drive it accepts no new work: the earlier error already satisfies that gate's terminal-reply check. A cached paused status can then disagree with a fresh snapshot. A consumed continuation also needs restart recovery when the process exits before its reply is recorded.

## Decision

Harness owns explicit recovery admission in `SessionResume`. Under the Session control lock it validates the observed pause and execution owner, then commits a deduplicated Inbox request, a Session recovery receipt, the reopened Rollout run and pause release together. HTTP acknowledges admission without waiting for inference. Prior errors and completed effects remain recorded; recovery adds input to the same task root. Already queued next tasks retain their own root instead of reopening a completed predecessor.

The receipt records the request, pause, task and Inbox identities and whether materialization consumed or cancellation removed the request. Repeated requests return the saved receipt. A request for an older pause cannot release a newer pause. Snapshot reads and sequenced status events project a committed request awaiting execution as queued activity. Pause release publishes the resulting status even without a live lease.

Restart recovery considers user continuations after a terminal reply, including continuations already materialized into history. It retains the task and pauses execution for explicit recovery. The schema adds optional receipt metadata: historical Sessions without it remain valid and enter the same admission path; no historical messages or errors are rewritten.

Web sends a request identity and observed pause, coalesces pending clicks, reports blocked or stale actions and checks the saved receipt after a lost response. It relies on the ordinary sequenced synchronization path for rendered execution state. BlueprintLoop uses the same recovery admission while its own owner retains loop identity, progress and review rules.

## Alternatives considered

**Clear the pause and force the loop.** A terminal failure still has no new user input for the model, and a crash between clearing and scheduling loses the recovery request.

**Delete the failed reply.** This destroys diagnostic evidence and can invalidate recorded tool and accounting history.

**Treat provider recovery timeout as unlimited automatic retry.** Explicit user recovery and automatic retry have different budgets. Recovery must not silently restart work after a process restart.

**Let refresh repair execution.** Reading the page must not change task intent. Live events and fresh snapshots must agree on committed state.

## Consequences

Continue has explicit admission outcomes and durable recovery identity. Automatic provider retry limits remain unchanged. A model may still fail again; that failure remains visible and resumable rather than becoming a successful completion. Completed runs, unavailable owners and unusable recording evidence remain guarded.

Behavioral coverage includes admission rollback, response loss, repeated clicks, a late request after another pause, cancellation, next-task admission, refresh status parity and restart before admission, after enqueue and after materialization. Full-runtime tests exercise ordinary tasks and BlueprintLoop with deterministic provider transport and real storage, message processing and workflow tools.
