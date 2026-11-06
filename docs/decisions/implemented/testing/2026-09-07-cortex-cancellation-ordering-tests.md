# Decision Record: Verify Cortex cancellation ordering with held processors

Status: implemented

## Problem

Cortex cancellation tests used elapsed-time limits to assert that cancellation does not wait for task processors. Instrumented runs could exceed the 250 ms limit while persisting cancellation normally. Tasks could also fail before cancellation, causing the tests to return without verifying the contract.

## Decision

The tests keep real temporary Scope and session storage and hold the session invocation boundary behind an explicit promise. Both single-task cancellation and cancellation of a child and grandchild must return while their processors remain pending. Assertions verify the cancelled state in memory and durable sessions and released concurrency slots. Cleanup releases the processors and restores the invocation boundary. A generous deadline detects a deadlock; elapsed time is not a success criterion.

## Alternatives considered

**Increase the elapsed-time thresholds.** A different threshold still depends on machine load and does not establish whether processor settlement is awaited.

**Skip cancellation when tasks fail to start.** This can pass without exercising cancellation. The fixture supplies a deterministic model identity and waits for each held invocation to begin.

## Consequences

The suite detects waiting on an unfinished processor without imposing a latency benchmark on persistence under coverage instrumentation. It verifies the Cortex cancellation boundary, while session processor abort handling remains the responsibility of the session tests. The invocation replacement must be restored and pending work released before leaving the temporary Scope.
