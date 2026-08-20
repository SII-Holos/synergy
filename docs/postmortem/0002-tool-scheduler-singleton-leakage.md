# Postmortem: ToolScheduler singleton leaked across CI shard-process tests

Status: implemented

## Executive summary

On 2026-08-20, every Linux CI run containing commit `f7b8e68956` (feat(agenda): session turn-event triggers) failed the same three `SessionProcessor auto-expand interception` tests in `packages/synergy/test/tool/auto-expand.test.ts`, expecting `completed` and receiving `error`. The root cause: `test/session/tool-scheduler.test.ts` stops the module-level `ToolScheduler` singleton and never restores it, and Bun runs each test shard in a single shared process, so the stopped singleton leaked into sibling files. The agenda commit added two test files that shifted the shard boundary, moving `auto-expand.test.ts` into the same shard as the leak source for the first time. It escaped because the failure did not reproduce on macOS (different shard composition) and the failing tests were initially misattributed to `test/workspace/policy.test.ts`.

## Summary

`ToolScheduler` (`packages/synergy/src/session/tool-scheduler.ts`) is a module-level singleton: `stop()` calls `closeAdmission()` which sets `accepting = false` and never restores it, and `dispatch()` rejects with "Tool scheduler is stopping" while admission is closed. `test/session/tool-scheduler.test.ts` exercises shutdown semantics and ends with `await ToolScheduler.stop()` (its final tests leave the singleton stopped).

Bun's `--shard` mode runs each shard's file group inside one shared process, so module-level state is shared across the files of a shard. `test/tool/auto-expand.test.ts` dispatches through the real `ToolScheduler`, so when the two files shared a shard and `tool-scheduler.test.ts` ran first, every auto-expand dispatch rejected and each tool part settled as `error`.

The agenda commit (`f7b8e68956`, PR #1219) added `test/agenda/session-trigger.test.ts` and `test/tool/agenda-watch.test.ts`. Shard assignment is a hash over file paths, so adding files shifted the boundaries: in the last green run `auto-expand.test.ts` sat in shard 2 and `tool-scheduler.test.ts` in shard 3 (different processes, no interference); in every failing run both sat in shard 4 with `tool-scheduler.test.ts` executing first.

The failure reproduced deterministically on Linux CI (`bun test --shard=4/4`) and locally with `bun test --shard=1/1 test/session/tool-scheduler.test.ts test/tool/auto-expand.test.ts` (3 fail) or by injecting `await ToolScheduler.stop()` at the top of an auto-expand copy (same 3 fail). Plain local runs stayed green because the default (non-shard) file order runs `auto-expand.test.ts` before `tool-scheduler.test.ts`.

## Timeline

- 2026-08-20 06:24 (UTC+08) — Merge of PR #1209 into `dev` CI run: green.
- 2026-08-20 06:30 — PR #1219 (`f7b8e68956`, feat(agenda): session turn-event triggers) first CI run: fails the three auto-expand interception tests.
- 2026-08-20 06:31 — PR #1219 merges into `dev`; every later `dev` push and every other PR merged after it fails the same three tests.
- 2026-08-20 14:54 — Investigation session starts from a report attributing the failure to `test/workspace/policy.test.ts` (that file was green throughout).
- 2026-08-20 ~16:00–18:00 — Local reproduction attempts (single file, file pairs, CI shard 4 file set, full suite, `bun run test:ci`) all pass on macOS; the CI timeline and shard-placement comparison narrow the cause to the agenda commit and shard-boundary movement.
- 2026-08-20 ~18:10 — Decisive reproduction: `bun test --shard=1/1` with both files reproduces the exact CI failures; injecting `ToolScheduler.stop()` reproduces them from a single file.
- 2026-08-20 ~19:30 — Fix committed (PR #1224): `afterAll` cleanup restores the singleton in both files.

## Root cause

The module-level `ToolScheduler` singleton is stopped by `tool-scheduler.test.ts` without restoration, and Bun shards share one process per shard, so the closed admission gate leaks into sibling files. The agenda commit did not touch the scheduler or auto-expand code; it changed the shard composition, which is a hash over test file paths.

Why every safety net missed it:

- Local runs did not reproduce because macOS shard composition differs from Linux CI (absolute-path hashing) and default non-shard order runs the victim before the leak source.
- `coverage-run.ts` already isolates `auto-expand.test.ts` from the shared-process coverage batch (its comment records the same shared-process sensitivity), but `test:ci` has no per-file isolation, so the sharded CI Test job stayed exposed.
- The report named `test/workspace/policy.test.ts`, which was green; the failing file was `test/tool/auto-expand.test.ts`, delaying the search.
- The failure pattern (success-path tests fail, error-path tests pass) pointed at dispatch rejection, but the trigger was an unrelated feature PR shifting shard boundaries.

## Guardrails added

- `test/session/tool-scheduler.test.ts` — `afterAll(() => ToolScheduler.configure())` restores the singleton after the shutdown suite (PR #1224).
- `test/tool/auto-expand.test.ts` — defensive `afterAll` that stops then reconfigures the scheduler, leaving the singleton clean regardless of shard order (PR #1224).
- Decision record [Restore the ToolScheduler Singleton in Shard-Process Tests](../decisions/implemented/testing/2026-08-20-tool-scheduler-singleton-restore.md) captures the cleanup decision and rejected alternatives.
- This postmortem records the incident narrative and the shard-boundary lesson.

## Lessons

- A test that stops or reconfigures a module-level singleton must restore it: Bun shards share one process per shard, and any future file addition can silently move a leak source next to a victim.
- Shard boundaries are a hidden test-isolation axis: a passing local run and a failing CI run can differ only in file-path hashing. When CI-only failures appear, compare shard composition between green and red runs before suspecting the changed code.
- Verify the failing file from CI logs before debugging: the reported file may be a misattribution.
