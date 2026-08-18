---
name: testing-guide
description: Design, write, run, and diagnose Synergy tests with Bun, temporary Scope isolation, deterministic fixtures, and behavior-first assertions. Use for TDD, bug regressions, feature tests, migration tests, flaky tests, coverage, package tests, frontend tests, and selecting verification gates.
---

# Test Synergy Behavior

## Define the Invariant First

1. State the observable contract and the failure that would violate it.
2. For a bug or new behavior, write the smallest failing test before the implementation. Skip a new test only for a pure refactor whose existing tests already cover unchanged behavior.
3. Assert public results, state transitions, emitted contracts, permissions, or recovery behavior. Avoid source-text assertions, private call counts, and snapshots of irrelevant structure.

## Choose the Lowest Useful Level

- pure function/schema: inline data and direct calls
- tool/domain behavior: real implementation plus isolated temp directory and Scope context
- persistence/migration: real storage, fresh-install and upgrade fixtures, restart/readback where relevant
- route/SDK: call the route or generated client contract
- session/LLM loop: real session state with deterministic provider/model fixtures
- Web/UI: component/context behavior plus the smallest browser or integration check needed
- package/release: build, pack, and validate the published artifact rather than source layout alone

Inspect two nearby tests and `packages/synergy/test/preload.ts` before introducing a new harness pattern.

Place every test under the owning package's `test/` directory, mirroring the relevant source domain when that helps navigation. Place repository-level script and policy tests under the root `test/` directory. Never cascade `*.test.*` or `*.spec.*` files beside implementation files in `src/`, `script/`, or another source directory. Run `bun run test-layout:check` when adding or moving tests.

For localized UI behavior, use a real Lingui `I18nProvider` with minimal English and Simplified Chinese messages. Assert visible text and accessibility labels after a reactive locale change; do not mock translation calls to return IDs because that hides missing catalogs and stale module-load translations. Keep plugin-author, user, LLM, path, identifier, and raw-error pass-through in the same boundary test as translated host chrome.

## Use Real Isolation

Use `tmpdir()` and `ScopeContext` instead of mocking Storage, Session, or the filesystem. The preload-managed `SYNERGY_TEST_ROOT` contains temporary fixtures for process-level cleanup, so do not move fixtures back to unmanaged operating-system temp paths or delete them while Scope-owned asynchronous work may still reference them. Restore environment variables and singleton state in cleanup hooks. Honor abort signals and dispose processes, Browser pages, servers, and timers.

Provider/model tests rely on `test/preload.ts` to seed the model catalog. The preload writes the pinned `test/tool/fixtures/models-api.json` fixture to `cache/models.json` under `SYNERGY_TEST_HOME` so the runtime disk-cache path resolves deterministically, sets `MODELS_DEV_API_JSON` to that cached path so the build-time macro and direct macro tests resolve the same fixture, and sets `SYNERGY_DISABLE_MODELS_FETCH=true` to suppress background network refresh. Update the fixture deliberately; never make deterministic tests depend on the live model catalog or real API keys.

Core binary builds also default to that pinned fixture. Test build behavior through `script/models-catalog.ts`: the selected catalog must satisfy the runtime schema and contain non-empty OpenAI, Anthropic, and Google providers before compilation. Ordinary local builds may use `MODELS_DEV_API_JSON` as an explicit override; release builds must force the repository-pinned snapshot so network and build-machine cache state cannot alter the artifact.

Tests that exercise the cold-cache path — where no disk or memory cache exists — must spawn a fresh Bun subprocess with a clean isolated home directory. The Bun preloader populates process-global state for the test harness, so the existing process always has a warm cache. A cold-cache test strips `SYNERGY_TEST_HOME` and `MODELS_DEV_API_JSON` from the child environment, sets `SYNERGY_HOME` to a fresh temp directory, and asserts against the child process output.

Use a fake or local boundary only where the external system is not the subject of the test. Do not add Jest/Vitest mocks to the Bun suite without an established package-specific reason.

## Run Core Suites Through the Orchestrators

Run `packages/synergy` tests through the package scripts, never a raw `bun test --coverage --parallel`:

```bash
cd packages/synergy
bun test test/<domain>/<file>.test.ts
bun run test:ci
bun run test:coverage
```

`test:ci` and `test:coverage` spawn every Bun child with an injected `SYNERGY_TEST_HOME`/`SYNERGY_TEST_ROOT` and no `SYNERGY_HOME`, because Bun 1.3.x does not propagate `test/preload.ts` environment into `--parallel` worker processes — a raw parallel/coverage run falls through to the real user home and writes fixtures into `~/.synergy/data`.

`src/global/index.ts` enforces this at module load: a test-entry process (`Bun.main`/argv matching `*.test.*`/`*.spec.*`, or `BUN_TEST_WORKER_ID`/`JEST_WORKER_ID` present) must carry the positive `SYNERGY_TEST_HOME` isolation marker, and is additionally blocked when the root is `os.homedir()/.synergy` or inside it (Windows paths normalized case-insensitively). If you see `TestHomeGuardError`, the run bypassed isolation: re-run through the package scripts or set `SYNERGY_TEST_HOME` to a dedicated test home. `SYNERGY_ALLOW_REAL_HOME=1` is the only escape hatch for a deliberate real-home run.

## Run Narrow to Broad

Core runtime commands run from `packages/synergy`:

```bash
bun test test/<domain>/<file>.test.ts
bun run test:changed
bun test
bun run test:ci
bun run test:coverage
```

Repository gates run from the root:

```bash
bun run typecheck
bun run quality:quick
bun turbo test
bun run quality
```

Localized frontend changes also run:

```bash
bun run --cwd packages/app i18n:extract
bun run localization:check
bun run --cwd packages/app build
```

Extraction must leave tracked PO catalogs unchanged, strict compilation must reject missing Simplified Chinese or invalid ICU messages, and the production build must keep non-English catalogs lazy while excluding development-only pseudo-localization. Exercise a Chinese cold start, rapid switching, catalog-load failure, `html.lang`, keyboard labels, and 375 px layout through an isolated Web/Desktop runtime.

Run the narrow failing test during iteration, then the affected package/domain suite, then `quality:quick`. Run the full suite when the change crosses shared abstractions, persistence, generated contracts, package publication, or release boundaries, or when the user requests it.

`bun run test:ci` is the CI-equivalent core suite. It runs four shards sequentially in fresh Bun processes to bound process-global state and fixture accumulation without introducing cross-shard port or environment races. Set `SYNERGY_TEST_JUNIT_DIR` to emit one JUnit report per shard.

Coverage has a floor. `bun run coverage:check` enforces per-package line/function thresholds (the only metrics Bun 1.3.14 exposes in lcov) with an auditable exemption list in `script/coverage-exempt.json`. The rules:

- Cover product logic with real behavioral tests before exempting anything.
- Every exemption entry carries a `reason`; entries that match nothing, overlap, or cover more than 25% of a package fail validation.
- Bun 1.3.14 supports no ignore comments (`istanbul ignore`, `v8 ignore`, and `c8 ignore` are all inert), so whole-file exemption is the only exclusion mechanism. Do not add ignore comments expecting them to work.
- A source file never loaded by any test counts as 0% and fails the package — add a real test that loads it rather than exempting blindly.

Use [Development reference](../../../docs/reference/development.md) and [Open-source quality](../../../docs/operations/open-source-quality.md) for current command ownership. Do not invent a root `bun test`; the root script intentionally rejects that ambiguous command.

## Diagnose Failures

1. Re-run the narrow test alone and capture the first causal failure.
2. Check isolation leaks, stale generated files, timeouts, open handles, environment restoration, ordering, and platform assumptions.
3. Distinguish a product regression from a brittle expectation. Change the test only when the intended public contract is wrong or was asserted at the wrong level.
4. Do not skip, weaken, or quarantine a relevant test merely to make the gate green.

## Handoff

Report the invariant, test location, red/green evidence, commands run, pass/fail counts, unrun gates, platform limitations, and any remaining nondeterminism.
