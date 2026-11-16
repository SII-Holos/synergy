# Process sampling raced original close completion

## Executive summary

A background process exited successfully, but a concurrent poll reported failure without an exit code. The stale-process sampler claimed completion before the original tracked close tail finished. Physical death is an observation, not evidence that no close owner remains.

## Summary

A real native background fixture completed stdin interaction and wrote its final output. Native execution, the saved Process record and the finished Registry entry all eventually reported exit code zero. The poll had already returned a transient failed result.

## Timeline

The diagnostic compared the actual native operation, child exit, persisted Process evidence and Registry completion. A smaller real-child test then held the original tracked tail after physical close and reproduced the sampler removing its live entry. The fix preserved that entry until its original owner finished; both the owning Registry suite and real background tool fixture passed.

## Root cause

`resourceSnapshot` settled a physically absent child through `markStale` without checking the Registry's tracked close set. That path supplied no original exit code and raced the asynchronous output and recording owner.

## Guardrails

The test uses an actual OS child with exit code zero, observes its physical close, holds the original tail and samples without waiting for that tail. It verifies no finished record appears early, then releases the owner and checks its real terminal result. Existing missing-child recovery remains covered.

## Lessons

Reconciliation must first establish that no original completion owner exists. Polling and resource sampling cannot infer the end of native saving from PID liveness alone.
