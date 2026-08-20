# Decision Record: Restore ToolScheduler admission after shutdown tests

Status: implemented

## Problem

`packages/synergy/test/session/tool-scheduler.test.ts` exercises module-level shutdown admission by calling `ToolScheduler.stop()`, which permanently sets the module `accepting = false`. The last test ended with `await ToolScheduler.stop()` and never restored the default accepting state. Bun runs several test files per worker process, so any later file in the same worker that dispatches a tool (the SessionProcessor auto-expand interception tests) had every `ToolScheduler.dispatch()` rejected with "Tool scheduler is stopping", leaving the tool part in `error` with `missing_execution_slot` metadata.

This was a test-order-dependent failure: `auto-expand.test.ts` passed alone and failed only when a previous file in the same worker had stopped the scheduler. It started failing CI after the agenda session-trigger change added new test files that shifted shard composition, placing the two files in the same shard.

## Decision

Add an `afterAll(() => ToolScheduler.configure())` hook to `test/session/tool-scheduler.test.ts` so the module-level scheduler returns to its default accepting state after the shutdown-admission tests finish. `configure()` already resets `accepting = true` and the default options, which is exactly the pre-test state.

## Alternatives considered

- **Reconfigure at the end of the last test instead of `afterAll`** — rejected: `afterAll` also covers a mid-file failure, and the hook is the established Bun idiom for cross-file state restoration.
- **Make `stop()` reopen admission** — rejected: runtime shutdown is intentionally permanent in production (`closeAdmission` is also called by `GlobalRuntime.closeAdmission`); reopening admission inside `stop()` would change runtime semantics to satisfy a test.
- **Make the auto-expand tests defensively re-open the scheduler** — rejected: the pollution belongs to the file that mutates shared module state; restoring at the source keeps every other test file safe from this class of failure.

## Consequences

- The full `test:ci` suite and the affected shard pass deterministically regardless of file order within a worker.
- Production shutdown semantics are unchanged; `ToolScheduler.stop()` remains permanent for real runtimes.
- Other module-level singletons that tests shut down (AgentTurn, PolicyWorker) still follow their own per-file restore conventions.
