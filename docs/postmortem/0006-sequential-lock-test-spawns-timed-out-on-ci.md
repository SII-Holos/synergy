# Postmortem: Sequential lock-worker spawns consumed the competition test budget on CI

Status: implemented

## Executive summary

From 2026-09-04, the `ServerProcessLock` competition test intermittently failed CI with a 120-second hook timeout while passing locally every time. The test spawned 24 lock-worker subprocesses one at a time, waiting for each to report ready before spawning the next; each wait was capped at 60 seconds, but the whole test ran on a 90-second budget, so under CI runner load the workers' cumulative startup consumed the budget before the competition phase began. Bun then killed the test mid-flight and reported the expiry as an `afterEach` hook timeout — pointing at lock contention and cleanup, not the spawn loop. A prior commit had already widened the per-wait caps once, treating the caps as the problem while the accumulation was the problem. The durable lesson: a loop of N steps each capped at T costs up to N×T — budget phases, not steps, and read which phase timed out before theorizing about the mechanism under test.

## Summary

`packages/synergy/test/daemon/server-process-lock.test.ts` verifies that exactly one of 24 concurrent processes acquires the daemon runtime lock. The worker script (`server-process-lock-worker.ts`) starts, appends its id to a ready file, and parks until a start file appears; the test then releases all workers and reads result lines. The test's spawn loop awaited each worker's ready line before spawning the next, with a 60-second cap per worker and a 90-second budget for the entire test.

The arithmetic: a spawn-and-ready cycle costs roughly 1–3 seconds on a development machine, so 24 workers take 30–70 seconds and fit the budget. Under a loaded CI runner each cycle costs several times more, and the sum crosses 90 seconds before the release file is even written. When the budget expired, Bun killed the test while the already-spawned children were still parked; the `afterEach` cleanup then blocked awaiting those children and the reported failure was `a beforeEach/afterEach hook timed out [120000.57ms]` (after reaping, `killed 2 dangling processes` appeared in the log). The lock logic under test was never exercised — the workers never got past the ready gate.

The failure recurred across three pushed commits on 2026-09-04/05 while every local run passed. Two of the three CI failures were absorbed by `rerun --failed` and came back green, which made the visible failure rate look like a rare flake rather than a near-certainty under runner load.

## Timeline

- 2026-08-15 — `683b49ee3` widens the per-worker ready/result caps from 30s to 60s after Windows CI observed a 35.4s wait. First fix attempt of this class: the caps grew, the accumulation did not.
- 2026-09-04 ~17:20 (UTC) — PR #1317's first CI round fails `ServerProcessLock` (120s hook timeout) alongside genuine Coverage failures from that PR; local rerun green; failed jobs rerun, green. Attributed to runner load.
- 2026-09-05 02:02 — #1317 merges; its own dev push fails with the same signature as the only Test failure.
- 2026-09-05 05:21 — #1318's dev push fails again, same signature, 1798 of 1799 tests passing.
- 2026-09-05 ~09:00 — PR #1324 investigation reads the spawn loop against the budget: the per-worker waits are caps but the phase is a sum. Workers park on `startPath`, so spawning them concurrently is race-free. Fix: spawn all workers up front, poll one shared ready set against a 60s deadline, raise the whole-test budget to 150s. Both competition tests (24- and 16-worker) get the same shape; local run completes both well inside the budget (9 pass, 4.1s file wall time).
- 2026-09-06 06:02–11:37 (UTC) — three more dev pushes (#1327, #1328, #1329) fail Windows Checks in the same suite: the shared 60s ready deadline expires with most workers already up (15/16, 23/24, 19/24 ready), the unbounded cleanup await stretches each failure to the full 150s test budget, and the reported "timed out after 150000ms" masks the deadline error that sits a few lines higher in the log. The identical lock code passes #1326 (02:12) and #1330 (11:37) on the same runner image within hours of the failures — load-dependent startup tail, not a regression.
- 2026-09-07 ~03:35 (UTC) — PR #1332's crash fast-fail converts the missing workers into evidence on the first PR run: Windows fails in 0.9s with `1 lock worker(s) exited before becoming ready (exit code 1; 4/24 ready)` above a worker `EBUSY: resource busy or locked, copyfile ... config.schema.json`. Fleet workers share one test home and die at module load while the startup schema sync copyfiles onto the same destination; the historical missing-worker counts (15/16, 23/24, 19/24) were crashed workers that a ready-only poll cannot distinguish from slow ones.

## Root cause

The spawn loop's per-worker deadline bounded each step, but the test budget bounded the phase: 24 sequential steps at CI-runner startup cost overflowed the phase before the mechanism under test ran. Every safety net missed it for a distinct reason:

- **Local runs did not reproduce** — dev-machine spawn latency is a fraction of a contended runner's; the failure needed load, not a logic bug.
- **The signature misdirected** — a budget expiry surfaces as an `afterEach` hook timeout (cleanup awaiting 24 parked children), so the stack trace pointed away from the spawn loop and invited lock-contention theories.
- **Rerun absorption hid the frequency** — counting failures per CI attempt instead of per pushed commit made a near-deterministic-under-load failure look like a rare flake that reruns could dismiss.
- **Prior art bias** — `683b49ee3` had already "fixed" the flake by widening caps, which seemed to confirm the load theory rather than question the loop's shape.

## Guardrails added

- PR #1324 (`9019eb80d`): both competition tests spawn every worker before waiting, poll a single shared ready set against a 60s deadline, and carry 150s per-test budgets above the worst observed CI startup; the `afterEach` reaper still bounds orphan cleanup.
- The decision record for the test-batching work (`docs/decisions/implemented/testing/2026-09-04-coverage-main-batch-sharding.md`) states the durable pattern for future worker-per-process suites: spawn-then-poll, with phase budgets sized to worst-case total startup.
- 2026-09-07 lock-fleet harness (`packages/synergy/test/daemon/lock-fleet.ts`): readiness is one 80s phase deadline, the competition result wait is 45s, and failure cleanup kills the fleet before awaiting exits behind a cancellable 20s grace — phase budgets sum to 145s inside the 150s test budget, so every failure lands as the harness's named error. A worker that exits before reporting ready fails the wait immediately with its exit code. Decision record: [Lock-fleet phase budgets and bounded cleanup](../decisions/implemented/testing/2026-09-07-lock-fleet-phase-budgets-and-bounded-cleanup.md).
- 2026-09-07 startup schema sync (`packages/synergy/src/global/index.ts`): the unconditional boot-time copyfile is skipped when the destination already matches and otherwise publishes through a unique same-volume temp rename, so concurrent startups into one home cannot collide on a Windows EBUSY; `test/global/schema-publish.test.ts` races four fresh processes per home and joins the Windows CI step. Decision record: [Startup schema publish is concurrency-safe](../decisions/implemented/bug-fix/2026-09-07-schema-publish-concurrent-safe.md).

## Lessons

- A per-step cap is not a phase budget. When a phase loops, the budget belongs to the phase: N steps capped at T each cost up to N×T.
- Read the failing phase before theorizing about the failing name. "A hook timed out" after a test-budget expiry describes cleanup of orphaned work, not the mechanism the test names.
- Green-on-rerun reduces visible failures, not underlying probability. Track flake recurrences per pushed commit, not per CI attempt, before classifying a failure as rare.
- Subprocess fleets that park on a gate file should spawn all workers first and poll one ready set: startup parallelizes, and the shared deadline bounds total startup instead of summing it.
- A failure path must not wait unboundedly on what it just failed to bound: when a deadline throws, kill the orphaned work first and await it behind a grace cap, or the cleanup converts a fast internal error into a full-budget timeout that hides the cause.
- A crash looks like slowness until something watches exit codes. Three fix rounds budgeted the startup tail while the missing workers were dying at module load; the first instrument that reported a worker's exit surfaced the product bug in a single run.
