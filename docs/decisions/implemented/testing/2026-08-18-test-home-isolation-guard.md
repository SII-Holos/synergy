# Decision Record: Test Home Isolation Guard and Orchestrator Env Injection

Status: implemented

## Problem

On 2026-08-16, a local full-suite coverage run against a `packages/synergy` worktree wrote channel, server, and session test fixtures into the real `~/.synergy/data` home (channel diagnostics, Clarus assignments, synthetic sessions, session index entries). The run used `bun test --coverage … --parallel=4`, and the worktree's `bunfig.toml` `[test] preload` was present. Bun 1.3.x does not propagate environment variables set by `test/preload.ts` (`SYNERGY_TEST_HOME`, `SYNERGY_TEST_ROOT`) into `--parallel` worker processes: the worker inherits the process launch env, not the preload-modified env, so `homeDir()` in `src/global/index.ts` falls through to `os.homedir()` and test code writes into the real user home.

The existing safeguards were per-fixture (`test/fixture/fixture.ts` `tmpdir()` throws when `SYNERGY_TEST_ROOT` is unset) and preload-dependent (the bunfig `[test] preload`). Neither covers code that writes directly through `Global.Path.data` inside a `--parallel` worker, and neither fails before the first write.

## Decision

Add two deterministic layers that do not depend on Bun's preload semantics:

1. **Runtime home guard** — `packages/synergy/src/global/test-home-guard.ts` exports `isTestEntryPath` (true when `Bun.main`/argv entry matches `*.test.*`/`*.spec.*`, or `BUN_TEST_WORKER_ID`/`JEST_WORKER_ID` is present) and `assertIsolatedTestHome(root, entryPath, argv, env)` which throws `TestHomeGuardError` unless the test-entry process carries the positive `SYNERGY_TEST_HOME` isolation marker, and additionally blocks when the resolved Synergy root is `os.homedir()/.synergy` or any path inside it even with the marker present (Windows paths are normalized case-insensitively before containment checks). `SYNERGY_ALLOW_REAL_HOME !== "1"` gates the whole check. `src/global/index.ts` calls it at module evaluation, before any `fs.mkdir` side effect, so a violated guard aborts the worker before it writes anything.

2. **Orchestrator env injection** — `packages/synergy/script/test-env.ts` exports `createIsolatedTestEnv()` which builds `{ SYNERGY_TEST_HOME, SYNERGY_TEST_ROOT }` under a fresh `synergy-orchestrated-*` temp root, deletes `SYNERGY_HOME` (deletion, not `undefined`, to avoid env stringification), and returns a `dispose()` that removes the root. `script/test-ci.ts` and `script/coverage-run.ts` pass this env to every spawned `bun test` child (and therefore to its `--parallel` workers). `packages/synergy/package.json` `test:coverage` now routes through `bun run script/coverage-run.ts`.

The guard is the last line of defense for any raw `bun test --parallel` invocation: a relocated real instance (custom `SYNERGY_HOME`) is indistinguishable from a disposable test directory by pathname, so the positive `SYNERGY_TEST_HOME` marker is required rather than trusting any non-default root. The orchestrator injection is the positive isolation for the two supported entry points (`test:ci`, `test:coverage`). `SYNERGY_ALLOW_REAL_HOME=1` is the documented opt-in for a deliberate real-home test run.

## Alternatives considered

**Fix Bun upstream or pass `--preload` explicitly.** No control over Bun 1.3.14 behavior; the incident already proved the guarantee fails; explicit `--preload` is unverified on 1.3.14 and redundant with deterministic env injection.

**Set test env via `bunfig.toml`.** Confirmed impossible: `[test]` has no env key on Bun 1.3.14 (issue #38215).

**Detect the runner with `BUN_TEST_WORKER_ID` only.** Misses serial runs; the combined entry-path/argv/worker-env predicate covers more shapes.

**Per-test cleanup of channel fixtures.** Treats the symptom; under working isolation the per-process temp-home wipe already removes everything; per-test cleanup adds flakiness and does not protect direct `Global.Path` writes.

**Cache `homeDir()` at module init.** Breaks existing tests that repoint `SYNERGY_TEST_HOME` mid-process and rely on the live getter.

**Extend to `packages/app`/`packages/ui` orchestrators.** No evidence of exposure: their suites never import core `src/global`, and their preloads have no home-dir dependence.

## Consequences

- Any `bun test --parallel` (or any test-entry process) resolving into the real home tree now fails loudly at module load with an actionable message and zero writes.
- `test:ci` and `test:coverage` are the two supported core-suite entry points and are always isolated; both orchestrators dispose the orchestrated temp root even when a batch fails (exit code set outside the disposal `finally`, never `process.exit` inside it).
- The `SYNERGY_ALLOW_REAL_HOME=1` escape hatch is explicit and documented.
- Future Bun upgrades that change preload-per-file semantics do not affect either layer, because neither depends on preload running.
- The remaining risk is a non-`*.test.*`/`*.spec.*` entry that imports core `src/global` with a real home and no isolation; that shape is not a test run by definition and is unaffected.
