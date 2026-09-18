# Decision Record: Open rollout runs at materialization instead of enqueue

Status: implemented

## Problem

`SessionInbox.enqueueUser()` runs on the `POST /session/:sessionID/input` critical path, and for every new task it awaited the full rollout admission chain before the HTTP response: a configuration snapshot via `Config.resolveExecutionDetails()` (which bypasses the scoped config cache and rescans global config, project fragments, and command/agent markdown), provenance capture that shells out to `git` three times per repository on both the runtime checkout and the session workspace, and a committed `RolloutJournal` transaction to attach the configuration. Every new task root is a new run, so every submit paid this cost in full while the client waited, and under the transactional storage's serialized write queue the effect compounded with frontend initial-sync reads on a newly created session.

A second serialized write on the same path was `Session.recordActivity()`, a full session-mutation boundary (canonical write plus page/nav/endpoint index projections and event publication) whose only purpose is bumping the activity timestamp.

## Decision

Enqueue splits admission into a cheap durable part and a heavy lazy part. After the inbox item is stored, enqueue opens a lightweight run shell through `RolloutLedger.beginRun()` — a single journal-committed `RunRecord` with status `running` and no configuration or provenance. Status polls (`GET /session/:sessionID/run/:runID`, used by `synergy send`'s completion loop) and cancellation observe this record immediately. The heavy admission work — configuration snapshot, provenance capture, journal commits — attaches at materialization, where `createUserMessage()` already calls `RolloutLifecycle.configuration()` with the same runID and the item's stored `input` (experiment and model included), off the request path. The shell write is best-effort: if it fails, enqueue still returns the queued item and materialization opens the run lazily.

Enqueue-time validation is preserved for the failures clients previously saw before an item was stored: `RolloutLifecycle.assertQueuedExperiment()` rejects experiment runtime mismatches and experiments attached to delegated runs without resolving configuration. Steer inputs still reject experiment configuration outright.

Deterministic configuration failures at materialization are terminal, not retried: `RolloutLifecycle.configuration()` wraps non-transient resolution errors in `RolloutAdmissionError`, `materializeNextTask()` parks admission-failed tasks beside payload-failed ones, and `createUserMessage()` terminalizes the run as `failed` so retry (`rearm`) reopens it. Transient storage pressure and non-cancellation DOM exceptions propagate without terminalizing the queued run; only `AbortError` is treated as cancellation. Parking checks the item's presence and writes the failed state in one storage transaction, preserving concurrent removal and propagating storage errors. `requireRunning()` reopens a zero-segment `interrupted` run — the shell a restart terminalized via startup recovery — so a queued task survives runtime restarts. Cancellation of a queued task whose shell never landed persists a durable cancelled record under the run lock via `RolloutLedger.cancelUnopenedRun()`. If the shell appears during that lookup, cancellation continues through normal owner signalling, drainage and terminal settlement instead of returning a still-running record. `cancel()` signals the live owner (`SessionManager.signalAbort`) before waiting on it. `Session.recordActivity()` after enqueue remains fire-and-forget.

## Alternatives considered

**Cache the expensive parts of admission (config snapshot, provenance) and keep full admission at enqueue.** A config cache keyed per scope and a (directory, HEAD)-keyed git cache would cut most of the cost, but enqueue would still hold the configuration journal commit and the session-mutation activity write on the request path, and cache invalidation would add a second source of truth for admission inputs that the loop side must re-resolve anyway at materialization.

**Open no run at enqueue at all (pure lazy admission).** Cheapest on the request path, but every status poll between enqueue and materialization 404s: `synergy send` polls `GET /session/:sessionID/run/:runID` with `throwOnError` immediately after submit and exits, and cancellation has no durable record to mark. The lightweight shell keeps those contracts for one journal write.

**Fail admission asynchronously and park the task like payload failures, without classifying failures.** Converting every client-visible rejection into a parked item hides experiment misconfiguration until after acceptance; and without distinguishing deterministic admission failures from transient ones, a busy store would permanently park healthy tasks. Enqueue keeps the cheap rejections synchronous, and only classified deterministic failures park.

## Consequences

Submit latency no longer includes configuration resolution, provenance git capture, or the configuration journal commit; a queued task is durable, visible, and pollable after one inbox transaction plus one shell journal write. Every queued task now opens a `running` run record before execution starts, so run listings include queued-but-not-materialized tasks and startup recovery terminalizes their shells as `interrupted` — which materialization then reopens. Experiment admission failures that depend only on runtime settings or delegation are still synchronous at submit; failures that need the resolved configuration snapshot surface at materialization as a parked, retryable failure with its run terminalized rather than as a submit-time error.
