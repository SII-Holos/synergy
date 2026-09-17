# Decision Record: Open rollout runs at materialization instead of enqueue

Status: implemented

## Problem

`SessionInbox.enqueueUser()` runs on the `POST /session/:sessionID/input` critical path, and for every new task it awaited the full rollout admission chain before the HTTP response: a configuration snapshot via `Config.resolveExecutionDetails()` (which bypasses the scoped config cache and rescans global config, project fragments, and command/agent markdown), provenance capture that shells out to `git` three times per repository on both the runtime checkout and the session workspace, and two committed `RolloutJournal` transactions to open the run and attach configuration. Every new task root is a new run, so every submit paid this cost in full while the client waited, and under the transactional storage's serialized write queue the effect compounded with frontend initial-sync reads on a newly created session.

A second serialized write on the same path was `Session.recordActivity()`, a full session-mutation boundary (canonical write plus page/nav/endpoint index projections and event publication) whose only purpose is bumping the activity timestamp.

## Decision

Enqueue no longer opens a rollout run. `enqueueUser()` stores the inbox item durably and returns; the run opens lazily when the queued task materializes, where `createUserMessage()` already calls `RolloutLifecycle.configuration()` with the same runID (the item's `messageID`) and the item's stored `input` (experiment and model included), so admission, provenance capture, and journal commits happen on the loop side, off the request path.

Enqueue-time validation is preserved for the failures clients previously saw before an item was stored: `RolloutLifecycle.assertQueuedExperiment()` rejects experiment runtime mismatches and experiments attached to delegated runs without opening a run or resolving configuration. Steer inputs still reject experiment configuration outright.

`RolloutLifecycle.cancel()` tolerates a runID that has no rollout run: if a queued inbox item matches the runID it is removed and a synthetic cancelled `RunRecord` is returned; a runID with neither a run nor queued work remains a not-found error. `Session.recordActivity()` after enqueue becomes fire-and-forget.

## Alternatives considered

**Cache the expensive parts of admission (config snapshot, provenance) and keep opening the run at enqueue.** A config cache keyed per scope and a (directory, HEAD)-keyed git cache would cut most of the cost, but enqueue would still hold two journal commits and the session-mutation activity write on the request path, and cache invalidation would add a second source of truth for admission inputs that the loop side must re-resolve anyway at materialization.

**Move only `recordActivity` off the critical path.** Cheaper and smaller, but the dominant cost is the admission chain (git subprocesses plus full config reload), so it would not fix the perceived submit latency on its own.

**Fail admission asynchronously and park the task like payload failures.** Rejected because it converts a client-visible 400 into a parked inbox item; users submitting an experiment with a mismatched runtime would see the task accepted and then fail silently instead of being told at submit time.

## Consequences

Submit latency no longer includes configuration resolution, provenance git capture, or rollout journal commits; a queued task is durable and visible after one inbox transaction. The run ledger for a queued-but-not-materialized task does not exist until materialization, so code that assumed `enqueueUser()` implies a running run must tolerate a missing run: cancel does, and `reopenRun`/`reconcile` already did. Experiment admission failures that depend only on runtime settings or delegation are still synchronous; failures that need the resolved configuration snapshot surface at materialization through the existing failed-run path instead of at submit.
