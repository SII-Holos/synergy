# Decision Record: Restore the ToolScheduler Singleton in Shard-Process Tests

Status: implemented

## Problem

`ToolScheduler` (`packages/synergy/src/session/tool-scheduler.ts`) is a module-level singleton whose `stop()` closes admission (`accepting = false`) without restoring it, and `dispatch()` rejects with "Tool scheduler is stopping" while admission is closed. `test/session/tool-scheduler.test.ts` exercises shutdown semantics and leaves the singleton stopped. Bun runs each `--shard` file group inside one shared process, so the closed singleton leaks into sibling files of the same shard and settles their tool parts as `error`. The incident that surfaced this, including the shard-boundary shift that exposed it, is recorded in [postmortem 0002](../../../postmortem/0002-tool-scheduler-singleton-leakage.md).

## Decision

Restore the module-level scheduler singleton in test cleanup so a file that stops it cannot poison its shard-process siblings:

1. `test/session/tool-scheduler.test.ts` — add `afterAll(() => ToolScheduler.configure())`. `configure()` resets `accepting = true` and options when no scheduler instance is live, leaving the singleton admitting work for subsequent files in the same shard process.
2. `test/tool/auto-expand.test.ts` — add a defensive `afterAll` that `await ToolScheduler.stop()` then `ToolScheduler.configure()`, so this file leaves the singleton clean regardless of what ran before it in the shard.

Both files still pass standalone (11 pass, 18 pass) and the exact reproduction command from the postmortem is green after the fix (29 pass / 0 fail).

## Alternatives considered

**Make production dispatch self-heal after a rejection.** Rejected: `accepting` is a deliberate shutdown gate; production code must not mask test-induced leakage, and a hidden auto-recovery could admit work during a real runtime shutdown.

**Move `auto-expand.test.ts` into the CI test isolation batch.** Rejected: `coverage-run.ts` already isolates it from the shared-process coverage batch, but `test:ci` has no per-file isolation concept; adding one for a single file would change CI structure for a test-hygiene issue.

**Reset the singleton in `tool-scheduler.test.ts` per test instead of once.** Rejected: an `afterAll` covers the whole file including the shutdown suite's final state with one hook, and mirrors the existing `afterAll` cleanup pattern used elsewhere in the suite.

## Consequences

- The shard-boundary sensitivity is removed: whichever file order Bun assigns, the scheduler singleton admits work between files.
- Both touched test files remain order-independent and pass under `--shard=1/1`, standalone, and in the full `test:ci` suite.
- The repository convention is reinforced: tests that stop or reconfigure a module-level singleton must restore it, because Bun shards share one process per shard (see [postmortem 0002](../../../postmortem/0002-tool-scheduler-singleton-leakage.md) and [test-home isolation guard](./2026-08-18-test-home-isolation-guard.md)).
