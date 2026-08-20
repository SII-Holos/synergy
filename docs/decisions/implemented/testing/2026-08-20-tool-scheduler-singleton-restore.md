# Decision Record: Restore the ToolScheduler Singleton in Shard-Process Tests

Status: implemented

## Problem

On 2026-08-20, every CI run containing commit `f7b8e68956` (feat(agenda): session turn-event triggers) failed the same three `SessionProcessor auto-expand interception` tests in `packages/synergy/test/tool/auto-expand.test.ts`, expecting `completed` and receiving `error`. `test/workspace/policy.test.ts` was green throughout. The failure started the moment the agenda commit merged into `dev` and reproduced on every later run, on Linux CI only.

The mechanism: `ToolScheduler` is a module-level singleton (`src/session/tool-scheduler.ts`) whose `stop()` sets `accepting = false` and never restores it; `dispatch()` rejects with "Tool scheduler is stopping" while admission is closed. `test/session/tool-scheduler.test.ts` exercises shutdown semantics and ends with `await ToolScheduler.stop()` without restoring the singleton. Bun runs each `--shard` file group inside one shared process, so the stopped singleton leaked into sibling files in the same shard. The agenda commit added two test files (`test/agenda/session-trigger.test.ts`, `test/tool/agenda-watch.test.ts`), which shifted the shard boundary: `auto-expand.test.ts` moved from shard 2 (green run) to shard 4 alongside `tool-scheduler.test.ts`, which executed first. Auto-expand's real `ToolScheduler.dispatch()` then rejected, settling every tool part as `error` — exactly the three failed assertions. Reproduced locally with `bun test --shard=1/1 test/session/tool-scheduler.test.ts test/tool/auto-expand.test.ts` (3 fail) and by injecting `await ToolScheduler.stop()` at the top of an auto-expand copy (same 3 fail).

## Decision

Restore the module-level scheduler singleton in test cleanup so a file that stops it cannot poison its shard-process siblings:

1. `test/session/tool-scheduler.test.ts` — add `afterAll(() => ToolScheduler.configure())`. `configure()` resets `accepting = true` and options when no scheduler instance is live, leaving the singleton admitting work for subsequent files in the same shard process.
2. `test/tool/auto-expand.test.ts` — add a defensive `afterAll` that `await ToolScheduler.stop()` then `ToolScheduler.configure()`, so this file leaves the singleton clean regardless of what ran before it in the shard.

Both files still pass standalone (11 pass, 18 pass) and the exact reproduction command is green after the fix (29 pass / 0 fail).

## Alternatives considered

**Make production dispatch self-heal after a rejection.** Rejected: `accepting` is a deliberate shutdown gate; production code must not mask test-induced leakage, and a hidden auto-recovery could admit work during a real runtime shutdown.

**Move `auto-expand.test.ts` into the CI test isolation batch.** Rejected: `coverage-run.ts` already isolates it from the shared-process coverage batch, but `test:ci` has no per-file isolation concept; adding one for a single file would change CI structure for a test-hygiene issue.

**Reset the singleton in `tool-scheduler.test.ts` per test instead of once.** Rejected: an `afterAll` covers the whole file including the shutdown suite's final state with one hook, and mirrors the existing `afterAll` cleanup pattern used elsewhere in the suite.

## Consequences

- The shard-boundary sensitivity is removed: whichever file order Bun assigns, the scheduler singleton admits work between files.
- Both touched test files remain order-independent and pass under `--shard=1/1`, standalone, and in the full `test:ci` suite.
- The repository convention is reinforced: tests that stop or reconfigure a module-level singleton must restore it, because Bun shards share one process per shard (see the postmortem and decision record for test-home isolation and the shared-process flake lessons).
