# Recycled Agent workers outlived Runtime shutdown

## Executive summary

Agent worker recycling removed a worker from the active pool before its native stop completed. Pool shutdown waited only for active workers, allowing a recycled worker's exit callback to run after its original Runtime closed.

## Summary

The actual Hosted recovery fixture completed native publication, ordinary startup, WSS reconnection and binary reads, then failed during cleanup with `Runtime is closed` from the original worker exit callback. A controlled stop barrier reproduced shutdown resolving while the recycled worker remained held.

## Timeline

1. Finish the actual restored Hosted writer's startup and read its original binary data.
2. Close the Runtime and observe its recycled worker exit callback arrive afterward.
3. Hold an original recycled worker's stop promise and demonstrate pool shutdown returning before release.
4. Retain native retirement completions separately from the schedulable worker Map.
5. Drain those completions from pool shutdown and the existing Session maintenance owner, then verify both the barrier and real recovery fixture.

## Root cause

The schedulable worker Map was also treated as the complete native process inventory. Recycling deleted its entry and launched an untracked asynchronous stop. Removing execution capacity did not end the worker's native lifetime.

## Guardrails

- `packages/harness/test/session/agent-worker-pool.test.ts` holds a recycled native stop across maintenance drainage and shutdown.
- Failed retirement remains observable to drainage instead of being cleared as successful cleanup.
- `packages/organization-runtime/test/backup/native.test.ts` retains actual ordinary startup, connection and teardown.
- Preserve original callbacks and sticky recording failures; no closed-Runtime fallback suppresses a late exit.

## Lessons

Shutdown and maintenance must drain accepted native lifetimes after those objects leave scheduling indexes. This fix does not establish settlement of a model gateway or repair the separate paused-task rollout tail.
