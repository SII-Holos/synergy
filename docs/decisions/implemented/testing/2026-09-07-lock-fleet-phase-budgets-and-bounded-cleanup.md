# Decision Record: Lock-fleet tests use phase budgets, crash fast-fails, and bounded cleanup

Status: implemented

## Problem

The `ServerProcessLock` competition suites failed Windows Checks on three consecutive dev pushes (2026-09-06, #1327–#1329) after two earlier fix rounds for the same file (postmortem 0006). The shared 60s ready deadline covered typical fleet startup but expired with 15/16 to 23/24 workers ready, so the lock mechanism under test never ran. The failure path then amplified the miss: when a deadline threw, the `finally`/`afterEach` cleanup awaited the still-starting children with no kill and no bound, so every internal failure stretched to the full 150s test budget and surfaced as an opaque `timed out after 150000ms` instead of the deadline error sitting a few lines higher in the log. Each recurrence cost a red dev branch, a manual rerun, and a misdirecting signature. A phase-budget arithmetic bug in the first harness draft (90s ready + 50s result + 20s grace > 150s budget) showed the same masking risk from the other direction: Bun would have interrupted cleanup and replaced the named error with the blanket timeout again.

## Decision

The fleet harness lives in `packages/synergy/test/daemon/lock-fleet.ts` with five contracts, shared by the 24-worker and 16-worker competition tests and reused by the single-worker suites' cleanup:

1. **One phase deadline per phase, summing under the test budget** — readiness 80s, competition results 45s, reap grace 20s: 145s aggregate inside the 150s per-test budget, so the full worst-case failure path lands as the harness's named error, never Bun's blanket timeout.
2. **Crash fast-fail** — a worker that exits before reporting ready fails the wait immediately with its exit code, because a parked worker only ever exits by crashing; the missing ready line is a diagnosable spawn failure, not a deadline wait. This contract found the real 2026-09-06 root cause ([startup schema publish was not concurrency-safe](../../implemented/bug-fix/2026-09-07-schema-publish-concurrent-safe.md)) in one CI run after three opaque timeouts.
3. **Spawn-handle retention** — `spawnFleet` records every child into the caller's tracking array as it is spawned, and a throwing spawn (exhausted processes or file descriptors on a loaded runner) reaps its partial fleet before rethrowing, so a mid-loop failure can never leak parked workers outside the caller's cleanup.
4. **Bounded, cancellable cleanup** — `reapAll` kills every still-running worker first, then awaits exits behind a 20s grace whose timer is cleared when the exits settle, so routine cleanup leaves no lingering timer holding the process open. `afterEach` reaps the shared children array with `splice(0)` behind the same bound.
5. **Result poll that separates torn from broken** — a newline-terminated line that fails to parse can never become valid and fails the wait immediately with the causal error; only the unterminated final segment of an in-flight append is tolerated until it terminates.

A regression test spawns an immediately-exiting worker and asserts the crash error (including the exit code) arrives within a bounded wait.

## Alternatives considered

- **Raise the test budget again (150s → 300s).** Rejected: the budget was already raised once for this flake class and the deadline/cleanup structure, not the allowance, converts startup-tail latency into opaque failures. A larger budget only hides slower workers behind the same broken signature.
- **Retry the whole test on failure.** Rejected: retries mask genuine regressions in the lock mechanism, and postmortem 0006 already documented how rerun absorption made a near-deterministic failure look rare.
- **Shrink the fleet (24 → 8 workers) to shorten the startup tail.** Rejected: competition width is the property under test — the lock must pick exactly one winner among many real processes. Shrinking the fleet weakens the invariant the suite exists to prove.
- **Skip the suite on Windows or mark it flaky.** Rejected: Windows is a first-class platform for the daemon lock, and skipping a relevant test to keep the gate green is against the repository's testing rules.
- **Keep `Promise.race` for the grace bound.** Rejected: the losing `Bun.sleep` timer stays scheduled for the full grace after fast exits, adding an unconditional ~20s process tail to every standalone suite run; an explicit cancellable timer costs the same line count.

## Consequences

Bought: this suite's CI failures now land in ~145s worst case with a named phase error, the crashing worker's exit code, or a malformed-result causal error, diagnosable from the log alone; the failure path can no longer outlive the test budget and mask its own cause, and routine cleanup no longer leaves a grace timer running. Normal runs are unchanged — both competition tests pass locally in ~4s total. Cost: the deadline constants encode assumptions about runner startup tails; infrastructure that pushes the tail past 80s again needs these constants revisited, not the test budget raised. The crash fast-fail assumes parked workers never exit normally — a future worker variant that legitimately exits before ready needs its own reporting channel or it will be blamed as a crash.
