# Decision Record: Lock-fleet tests use phase budgets, crash fast-fails, and bounded cleanup

Status: implemented

## Problem

The `ServerProcessLock` competition suites failed Windows Checks on three consecutive dev pushes (2026-09-06, #1327–#1329) after two earlier fix rounds for the same file (postmortem 0006). The mechanism had moved past the sequential-spawn bug #1324 fixed: the shared 60s ready deadline covered typical fleet startup but not the heavy tail of 24 cold `bun run` spawns under runner load — the deadline expired with 15/16 to 23/24 workers ready, so the lock mechanism under test never ran. Worse, the failure path amplified the miss: when the deadline threw, the `finally`/`afterEach` cleanup awaited the still-starting children with no kill and no bound, so every internal failure stretched to the full 150s test budget and surfaced as an opaque `timed out after 150000ms` instead of the deadline error sitting a few lines higher in the log. Each recurrence cost a red dev branch, a manual rerun, and a misdirecting signature.

## Decision

The fleet harness lives in `packages/synergy/test/daemon/lock-fleet.ts` with four contracts, shared by the 24-worker and 16-worker competition tests and reused by the single-worker suites' cleanup:

1. **One phase deadline for readiness, 90s** — sized above the worst observed CI tail (60s expired 5 workers short) and inside the 150s per-test budget. Never a sum of per-worker waits.
2. **Crash fast-fail** — a worker that exits before reporting ready fails the wait immediately with its exit code, because a parked worker only ever exits by crashing; the missing ready line is a diagnosable spawn failure, not a deadline wait.
3. **Bounded cleanup** — `reapAll` kills every still-running worker first, then awaits exits behind a 20s grace via `Promise.race`, so the worst-case failure path (90s deadline + 20s grace) stays inside the budget and the harness's own deadline error remains the visible signature. `afterEach` reaps the shared children array with `splice(0)` behind the same bound.
4. **Torn-line tolerance in the result poll** — a partially appended JSON line means a worker is mid-write; the poll retries instead of failing on a transient parse error.

A regression test spawns an immediately-exiting worker and asserts the crash error (including the exit code) arrives within a bounded wait.

## Alternatives considered

- **Raise the test budget again (150s → 300s).** Rejected: the budget was already raised once for this flake class and the deadline/cleanup structure, not the allowance, converts startup-tail latency into opaque failures. A larger budget only hides slower workers behind the same broken signature.
- **Retry the whole test on failure.** Rejected: retries mask genuine regressions in the lock mechanism, and postmortem 0006 already documented how rerun absorption made a near-deterministic failure look rare.
- **Shrink the fleet (24 → 8 workers) to shorten the startup tail.** Rejected: competition width is the property under test — the lock must pick exactly one winner among many real processes. Shrinking the fleet weakens the invariant the suite exists to prove.
- **Skip the suite on Windows or mark it flaky.** Rejected: Windows is a first-class platform for the daemon lock, and skipping a relevant test to keep the gate green is against the repository's testing rules.

## Consequences

Bought: this suite's CI failures now land in ~90s worst case with a named phase error or the crashing worker's exit code, diagnosable from the log alone; the failure path can no longer outlive the test budget and mask its own cause. Normal runs are unchanged — both competition tests pass locally in ~4s total. Cost: the deadline constants (90s ready, 20s grace) encode assumptions about runner startup tails; a runner-infrastructure change that pushes the tail past 90s again needs these constants revisited, not the test budget raised. The crash fast-fail assumes parked workers never exit normally — a future worker variant that legitimately exits before ready needs its own reporting channel or it will be blamed as a crash.
