# Postmortem: Coverage-mode test run wrote fixtures into the real Synergy home

Status: implemented

## Executive summary

On 2026-08-16, a local full-suite coverage run against a `packages/synergy` worktree wrote channel, server, and session test fixtures into the real `~/.synergy/data` home. The worktree's `bunfig.toml` `[test] preload` was present, but Bun 1.3.x does not propagate preload-set environment variables into `--parallel` worker processes, so `SYNERGY_TEST_HOME` was never set in the workers and `homeDir()` fell through to `os.homedir()`. The isolation relied on a preload behavior that does not hold under `--parallel`.

## Summary

The `packages/synergy` test suite is isolated by `test/preload.ts`, which sets `SYNERGY_TEST_HOME` and `SYNERGY_TEST_ROOT` to a per-process temp root and deletes `SYNERGY_HOME`. The preload is wired through `bunfig.toml` `[test] preload`. On 2026-08-16 20:03 and 20:29 (+08:00), a CI-repair session (`ses_ff8fa09c2ffes2dUsKLnijr5x6`, PR #1168 work) ran full-suite coverage commands from a worktree's `packages/synergy`:

- `bun test --coverage … --workers 1` (serial experiment)
- `LC_ALL=C bun test --coverage --coverage-reporter=lcov --parallel=4 --timeout 30000`

Both worktrees carried the preload in `bunfig.toml` (verified via `git show`), yet test fixtures from `test/channel/*`, `test/server/channel.test.ts`, and `test/session/boss-workflow.test.ts` landed in the real `~/.synergy/data`:

- `channel/diagnostics/` — 22 synthetic account records (`ndjson-schema-<uuid>`, `diag-redact-<uuid>`, `secret-project`)
- `channel/providers/clarus/accounts/cb47b20d2…/` — assignment + `assignment_session_index` (`proj-discover`, `task-1`, "Complete the task")
- `channel/providers/github/` — account workspace index
- `sessions/scope_21x4totapii/`, `sessions/scope_9rhzucvxdga/` — synthetic scope sessions
- `sessions/home/ses_ff572deb5…/` — "Runtime Boss" inbox session from `test/session/boss-workflow.test.ts`
- matching `session_index/` entries

Timestamps on the artifacts match the two runs exactly.

## Timeline

- 20:03:37 — serial full coverage experiment starts (`bun test --coverage … --workers 1`).
- 20:06–20:09 — first batch of channel diagnostics + Clarus assignment records written to the real home.
- 20:29:36 — CI-equivalent run starts: `LC_ALL=C bun test --coverage --coverage-reporter=lcov --parallel=4 --timeout 30000`.
- 20:29–20:30 — second batch: synthetic scope sessions and "Runtime Boss" session written to the real home.
- 20:40–20:49 — session discusses isolation; the pollution is not noticed until days later (user reports unarchivable channel projects).
- 2026-08-18 — the pollution is discovered and cleaned up (see Guardrails added).

## Root cause

Bun 1.3.x runs `--parallel` test files in worker processes that inherit the process-launch environment, not the preload-mutated environment. `test/preload.ts` sets `SYNERGY_TEST_HOME` inside the main process, so serial runs are isolated; worker processes do not see the variable, `src/global/index.ts` `homeDir()` falls through to `os.homedir()`, and every `Global.Path.data` write lands in the real home.

Why every safety net missed it:

- `test/fixture/fixture.ts` `tmpdir()` guards `SYNERGY_TEST_ROOT` for fixture-based tests, but channel/server/session suites write directly through `Global.Path.data` and never call `tmpdir()`.
- The preload is a bunfig wiring; the incident's `--config`/`--parallel` shapes are exactly the paths where it does not apply.
- Nothing fails before the first filesystem write, so a polluted run looks successful (the suites pass; their assertions check in-temp behavior, not where the writes landed).

## Guardrails added

- **Runtime home guard** — `packages/synergy/src/global/test-home-guard.ts` + a call in `src/global/index.ts` before any `fs.mkdir` side effect. A test-entry process (`Bun.main`/argv matches `*.test.*`, or `BUN_TEST_WORKER_ID`/`JEST_WORKER_ID` present) resolving the real home now throws `TestHomeGuardError` at module load, with an actionable message, before writing anything. `SYNERGY_ALLOW_REAL_HOME=1` is the documented opt-in.
- **Orchestrator env injection** — `packages/synergy/script/test-env.ts` injects `SYNERGY_TEST_HOME`/`SYNERGY_TEST_ROOT` and deletes `SYNERGY_HOME` in every child spawned by `test-ci.ts` and `coverage-run.ts`; `test:coverage` now routes through the orchestrator. Even when preload does not run in a child, the spawned env carries the isolation.
- **Regression tests** — `test/global/test-home-guard.test.ts` (unit + subprocess incident-shape contract), `test/script/test-env.test.ts`, extended `test/script/test-ci.test.ts`.
- **Decision record** — `docs/decisions/implemented/testing/2026-08-18-test-home-isolation-guard.md`.
- **Pollution cleanup** — forensics-verified 8/16 artifacts removed with a backup manifest at `~/synergy-backup-test-pollution-20260818-110911`; pre-incident data (7/28 channel workspaces, real Clarus account `f2c6ca87-…` with 4 projects, `managed_ownership`, `projects`) preserved. `~/.synergy/plugin.lock` was suspected to carry a test mutation but was deliberately not touched because it is the live runtime lock.

## Lessons

- Isolation that depends on a preload script only holds for the invocation shapes where the preload actually runs. Anything that spawns a different process shape (`--parallel`, `--config /dev/null`, IDE runners) must either re-inject the environment at spawn time or fail before side effects.
- A test run that writes to the wrong home still "passes" because the assertions check behavior, not write location. A guard at the storage boundary is the only way to make the wrong-location case loud.
- Before running full-suite experiments, verify the actual env inside the spawned worker process (`process.env.SYNERGY_TEST_HOME`), not the bunfig wiring.
