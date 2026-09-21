# Decision Record: Settle rollout uploads before attempt completion

Status: implemented

## Problem

A network failure can reject fetch while its native upload reader still holds the request stream lock. Closing the recorded attempt at that point lets pending request chunks arrive after the recorder has removed its active attempt, turning a transport failure into a recording failure.

## Decision

The transport owns request cancellation independently of the consumer lock. Every attempt finalizer settles the request reader, drains admitted writes and records the request body boundary before emitting the terminal attempt event. Request-side error handling does not re-enter the finalizer while that finalizer awaits the request pull. See [rollout evidence](../../../reference/rollout.md#evidence-and-accounting).

## Alternatives considered

**Ignore chunks after attempt completion.** This hides captured bytes and turns a lifecycle error into silent evidence loss.

**Cancel only unlocked streams.** Native fetch owns the lock during the failure being repaired, so that condition leaves the race intact.

## Consequences

Failed uploads preserve their original transport error and partial recording. Early responses also settle unfinished uploads before completion. Terminal delivery waits for admitted evidence writes; actual recording failures still stop execution. Regression coverage uses a cloned Request and the real ledger/recorder, alongside the existing transport cancellation and recording-failure tests.
