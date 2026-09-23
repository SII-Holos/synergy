---
name: testing-guide
description: Design, write, run, and diagnose Synergy tests with Bun, temporary Scope isolation, deterministic fixtures, and behavior-first assertions. Use for TDD, bug regressions, feature tests, migration tests, flaky tests, coverage, package tests, frontend tests, and selecting verification gates.
---

# Test Synergy Behavior

## Define the Invariant First

1. State the observable contract and the failure that would violate it.
2. For a bug or new behavior, write the smallest failing test before the implementation. Skip a new test only for a pure refactor whose existing tests already cover unchanged behavior.
3. Assert public results, state transitions, emitted contracts, permissions, or recovery behavior. Avoid source-text assertions, private call counts, and snapshots of irrelevant structure.

Seed large SQLite fixtures inside a transaction so per-row durability flushes do not dominate correctness test deadlines. Preserve the dataset size and the migration, restart, and failure boundaries exercised by the test.

Compare directory snapshots as sorted paths or sets when asserting unchanged files; filesystem enumeration order is not a product invariant.

Prepare durable fixtures before starting a short runtime deadline; for Cortex timeout tests, enqueue follow-ups between `Cortex.prepare` and `Cortex.start` rather than racing their writes against the timer.

For worktree lifecycle changes, exercise concurrent name selection after admission, setup descendants, unregistered directory users, active-turn selection/removal, cancellation and deferred unlock. Verify that metadata writes do not serialize a read-only turn.

For retirement changes, overlap cleanup in independent repositories and include commands whose write footprint is broader than the retired directory. Verify that broader ownership is reserved before directory exclusion, that nested writes cannot wait on their own lifecycle claim, and that undeclared expansion fails before queuing. Capture ownership state for an unexplained timeout; a green rerun alone does not identify its cause.

For process-backed write evidence, test the interval after native exit but before archive completion: an overlapping writer must remain excluded, disjoint roots must proceed, and finalizer failure or Runtime death must not leave a completed process permanently occupied.

For non-blocking and ordering contracts, hold the downstream operation behind an explicit promise and assert the upstream result while it remains pending. When asserting that an inbox item remains queued after an operation that schedules a wake, hold a real SessionManager loop lease on the worker; clean up its queued work before releasing the lease so a delayed wake cannot escape the fixture. For cross-process lock tests, hold the first owner behind an explicit parent release message and retain readiness as a promise; do not poll for a transient exact log snapshot. Release the owner only after the contender reports actual acquisition contention, not merely startup or intent to call the lock API. Drain child stderr and register process cleanup before awaiting startup. Use a generous test-framework timeout only to detect deadlocks, release the barrier in cleanup, and avoid wall-clock performance thresholds in instrumented correctness suites. Do not wrap correctness-only completion signals in shorter `Promise.race` timers: filesystem and worktree startup contention can exceed those incidental budgets on CI.

When a public operation returns a typed in-progress outcome at its foreground budget, correctness tests must await its documented completion path before asserting durable results. Exercise that outcome with an explicit held-operation fixture; do not raise the product deadline or swallow unrelated failures.

## Choose the Lowest Useful Level

- pure function/schema: inline data and direct calls
- tool/domain behavior: real implementation plus isolated temp directory and Scope context
- persistence/migration: real storage, fresh-install and upgrade fixtures, restart/readback where relevant
- route/SDK: call the route or generated client contract
- session/LLM loop: real session state with deterministic provider/model fixtures
- Web/UI: component/context behavior plus the smallest browser or integration check needed
- external agent adapters: execute a deterministic protocol fixture as a real child through the public Adapter interface; verify stdin, event framing, tool errors, usage, thread isolation/resume, credential filtering and shutdown rather than only private argument builders
- package/release: build, pack, and validate the published artifact rather than source layout alone; run the shared CLI artifact behavior suite against both core and full binaries with `SYNERGY_TEST_ARTIFACT_BIN`, including actual model/tool execution. Help and health checks do not validate product lifecycle delegation.

Inspect two nearby tests and `packages/harness/test/support/preload.ts` before introducing a new harness pattern.

Importing an App `src/components/**` module directly from `bun:test` needs its module-load side effects satisfied first: `mock.module("@/locales/en/messages.po?lingui", () => ({ messages: {} }))` for the catalog, because the `.po?lingui` module is not Bun-loadable, and a stub for anything reaching `@ericsanchezok/synergy-ui/icon`, whose `lucide-solid` `Dynamic` chain throws "Client-only API called on the server side". Prefer extracting the logic under test into a plain module (a classifier, a resolver, a projection) and testing that directly; reach for the mocks only when the component's own wiring is the subject.

The Web runner's `browserOnly` list selects module conditions, not process isolation. Suites that replace shared router, server, SDK or theme modules must also appear in `isolated`, so their mocks cannot affect lazy imports in sibling suites. Check both lists when a suite passes alone but fails with missing exports in a CI batch.

Place every test under the owning package's `test/` directory, mirroring the relevant source domain when that helps navigation. Place repository-level script and policy tests under the root `test/` directory. Never cascade `*.test.*` or `*.spec.*` files beside implementation files in `src/`, `script/`, or another source directory. Run `bun run test-layout:check` when adding or moving tests.

For localized UI behavior, use a real Lingui `I18nProvider` with minimal English and Simplified Chinese messages. Assert visible text and accessibility labels after a reactive locale change; do not mock translation calls to return IDs because that hides missing catalogs and stale module-load translations. Keep plugin-author, user, LLM, path, identifier, and raw-error pass-through in the same boundary test as translated host chrome.

## Use Real Isolation

Per-session recovery tests must migrate only their owned session fixture. Exercise the global migration runner separately with a dedicated home; a process-wide migration scan can encounter intentionally incomplete records from unrelated suites or earlier shards.

Use `tmpdir()` and `ScopeContext` instead of mocking Storage, Session, or the filesystem. The preload-managed `SYNERGY_TEST_ROOT` contains temporary fixtures for process-level cleanup, so do not move fixtures back to unmanaged operating-system temp paths or delete them while Scope-owned asynchronous work may still reference them. Create an explicit package Runtime fixture and run test bodies and relevant hooks inside `runtime.run()`. Set environment overrides before opening; changing `process.env` after startup does not change a captured Host. Close the fixture before deleting its home. Keep registration in its composition, never at module evaluation. Do not enter `describe()` through an asynchronous Runtime context; Bun collects callbacks before running them. For parameterized tests capture a ready module fixture with `bind`, or enter a per-test fixture when the callback runs. A module-level replacement of a process global — `globalThis.fetch` above all — is visible to every sibling file in the same shard process: capture the original before installing the replacement and restore it in `afterAll`, because a per-test `finally` that re-reads `globalThis.fetch` restores the replacement, not the original. Honor abort signals and dispose processes, Browser pages, servers, and timers.

Cancellation tests must cover the interval after execution ownership releases but before asynchronous ledger reconciliation finishes, preserving interrupted call evidence and the terminal cancellation result.

Capture process-global loop observations by their owning Session ID and assert the target Session's requests. A single last-call variable can be overwritten by unrelated background work; exercise an independent Session and drain the owned Cortex task before restoring loop mocks.

Electron fixtures should launch the resolved Electron executable rather than the npm CLI wrapper so timeout signals reach the owned application. Include cold startup and teardown in the test budget, and retain phase diagnostics on failure.

Browser acceptance tests that combine history navigation with connection recovery must validate the final canonical message state when recovery removes a pending navigation control. Keep errors for controls that remain present, require the latest message to be rendered, and retain reconnect and bounded-window assertions under delayed responses.

Process lifecycle assertions must wait for the observable completion state within the configured startup/shutdown deadlines, not a fixed number of millisecond sleeps. Keep generation, PID, cleanup and recovery-evidence assertions, and dispose owned processes in `finally`. For persistence jobs, reserve cleanup time within the package test deadline and cancel/drain unfinished jobs before restoring dependencies or deleting their database. Installed binary jobs must align `SYNERGY_BUILD_TARGETS` with the runner ABI and staged required helpers; `--single` alone can select both GNU and musl on Linux.

Provider/model tests use the package preload configured in `bunfig.toml`; `packages/testing/src/preload.ts` seeds the model catalog. The preload writes the pinned `packages/testing/fixtures/models-api.json` fixture to `cache/models.json` under `SYNERGY_TEST_HOME` so the runtime disk-cache path resolves deterministically, sets `MODELS_DEV_API_JSON` to that cached path so the build-time macro and direct macro tests resolve the same fixture, and sets `SYNERGY_DISABLE_MODELS_FETCH=true` to suppress background network refresh. Update the fixture deliberately; never make deterministic tests depend on the live model catalog or real API keys.

Core binary builds also default to that pinned fixture. Test build behavior through `script/release/shared/build/models-catalog.ts`: the selected catalog must satisfy the runtime schema and contain non-empty OpenAI, Anthropic, and Google providers before compilation. Ordinary local builds may use `MODELS_DEV_API_JSON` as an explicit override; release builds must force the repository-pinned snapshot so network and build-machine cache state cannot alter the artifact.

For embedded Runtime lifecycle changes, repeat real open/task/close cycles in one process and verify resource release as well as port reuse. Native HTTP handlers can retain their creation context after the server stops; release handler references outside the Runtime after requests and sockets drain. Check per-instance database maintenance timers at closure. Use a focused reachability regression for a demonstrated retention defect; RSS alone includes allocator caches and cannot prove ownership release.

Cold-cache tests construct a fresh Runtime and an unseeded isolated home. Module imports and the test preloader do not populate another instance’s caches. Use a subprocess when process startup, native callbacks, signals, installed artifacts or worker protocols are the contract. Never remove the positive test-home isolation marker.

Compile standalone Bun artifacts in a fresh `bun build --compile` subprocess, drain both output streams, and assert its exit code before exercising the executable. In-process compilation after plugin builds can reuse invalid compiler state on Linux; retain the artifact behavior assertions and run the combined suites under coverage. See the [standalone compilation decision](../../../docs/decisions/implemented/testing/2026-09-23-isolate-standalone-plugin-kit-compilation.md).

Exercise opt-in and platform-specific entrypoints with the same explicit ownership. A developer's PATH can hide an unowned executable lookup, and an undefined build-time digest can hide import-time Home access. Test isolated PATH/Home lookup and compiled constants without an active Runtime. Coverage failure summaries must retain the owning test file for unnamed setup/teardown failures so CI truncation does not discard their identity.

Linux OS-sandbox probes that replace `/tmp` need an explicit fixture Home outside that mount. Use a unique directory in the owning package's ignored `.artifacts`, close its Runtime before removal, and clean it on opening failure. Keep ordinary fixtures under the shared test root. Preserve positive command-start and host-baseline assertions so a hidden working directory cannot pass as a successful denial.

Full runtime fixtures that exercise model execution must serve both chat and embedding protocols when Library is enabled; a fresh home must not silently turn an execution test into a Hugging Face model-download test. Keep Library retrieval/encoding enabled and assert the normal execution evidence; validate real embedding assets separately.

Use a fake or local boundary only where the external system is not the subject of the test. Do not add Jest/Vitest mocks to the Bun suite without an established package-specific reason.

Playwright DOM-test fixtures that boot a Vite dev server must declare their package prerequisites: published Plugin entries use the root coverage command’s dependency build; alias other workspace-package entries whose `import` condition points at gitignored `dist/` output to their source entry when the fixture tests source behavior; resolve runtime packages that break under dependency pre-bundling (Lingui's `@messageformat/parser` chain) to minimal fixture-local stubs when the suite asserts behavior unrelated to i18n rendering, or add them to `optimizeDeps.include` when the real runtime is the subject; set `optimizeDeps.include` for the Solid runtime/JSX runtime/zod with `noDiscovery: true` so the optimizer never re-runs mid-load and reloads the page; scope `cacheDir` to the fixture temp directory so sibling Playwright servers sharing `node_modules/.vite` cannot invalidate each other; `warmupRequest` the fixture entry before launching the browser and surface page/console/HTTP errors in the failure message instead of a bare 30s selector timeout; and register the suite in the package's `playwrightIsolated` list so bun's worker reaping cannot kill its Chromium process mid-suite. See the [hermetic Vite fixtures decision](../../../docs/decisions/implemented/testing/2026-08-31-hermetic-vite-fixtures-for-playwright-dom-tests.md). Root production-host UI acceptance follows the same process isolation: run `bun run plugin-ui:test`, which starts one Bun process per suite in sequence, instead of passing the entire browser directory to `bun test`.

For inbox-to-transcript transitions, exercise settlement while a real inbox item has been drained but its message is still being materialized, then again after materialization. Verify that the continuation and a task queued behind it both execute. Test persisted contradictory terminal state through the registered migration as well as fresh runtime ordering; a restart-only test cannot prove that durable state was repaired.

Recovery migrations must also exercise startup with no newly queued task, failed wake attempts, and repeated startup. Persisting repaired state alone does not prove that startup can discover and execute the work. When adding migration imports, run the fresh-process migration registration and owner-ledger tests; a suite with preloaded session modules can hide a cold-import cycle.

For startup maintenance, pair real SQLite lifecycle tests (opening DDL, VACUUM/checkpoints, verification and failed DDL) with a fake monotonic clock at the Desktop consumer. Cover overlapping operations, duplicate/stale events, phase changes during maintenance, completion returning to the underlying deadline, and failure/worker loss. Assert observers run in the caller context even after transaction retries. Exercise split stdout/stderr and reused log files through a real managed child, then validate indeterminate elapsed time and long error details in Electron. Never let small fixtures or pre-recorded progress alone certify producer-to-consumer coverage.

## Local Performance Experiments

For startup-to-conversation acceptance, test fresh, historical and large homes through durable input admission, canonical publication and model completion on the same fixture. Include multi-turn recall, duplicate admission, retry after pause, terminal historical roots and repeated Runtime restarts. Record the fixture's node, record, owner and artifact distributions; a large unrelated namespace proves cleanup scaling but does not establish retention owner-enumeration capacity. Keep machine-dependent timing thresholds in local reports, with correctness and recovery invariants in CI.

Budget live model calls at the provider boundary before forwarding them, counting auxiliary tasks and retries as well as user turns. Preserve interrupted attempts and explicitly record configuration variants. A soak report must identify the source revision and process restart boundaries; source edits do not reload an already-running parent's modules.

Benchmark adapters must pass the environment's `agent_process_env` to the agent invocation so restricted-network tasks retain the evaluator's inference egress. Test both proxy-enabled and ordinary environments while keeping provider credentials in temporary private files. Validate streamed requests through the proxy and recording path: a direct provider probe, an internet-enabled task, or a successful proxy HEAD request does not establish that the actual model transport works.

Test process signals through an actual child process after a deterministic provider readiness barrier. An in-process abort or timer preserves different async context from an operating-system signal; both paths must retain Scope ownership and terminal accounting.

Use the [benchmark workspace](../../../benchmark/README.md) for model-backed task subsets and A/B evidence. Keep the evaluator, measured source, runtime recipe and dataset identities separate. Compare complete task-repeat pairs; preserve interrupted attempts and unknown accounting. Never substitute a static task-manifest check for an oracle/verifier execution result. Run the deterministic local-provider Docker test when changing preparation, the CLI bridge, cancellation, mounts or rollout capture. For stream/recording changes also run `SYNERGY_ROLLOUT_LONG_STREAM=1 bun test --cwd packages/harness test/session/rollout-long.test.ts`; independent CI workers own its completed, cancelled and failed outcomes, and the test aggregate requires all three. Keep each large outcome in a separate process so a timed-out test body cannot overlap the next pressure sample; retain the full byte/checkpoint load and report persistence, archive verification, and fixture-cleanup progress. Size the test and outer job deadlines to include deletion of the retained evidence, with job time remaining for process cleanup. Preserve official time limits and failed rewards during live acceptance. Inspect exporter exit/signal/deadline, archive validation, recording coverage, unknown usage and owned Docker residue independently. Test terminal-evidence reconciliation before allowing resume to schedule another paid attempt. Container-created mode-0600 accounting and mode-0700 ledger directories are not host-readable on Linux until Pier hands logs back. Test that boundary without widening permissions; inspect active evidence inside the verified owned container.

## Run Core Suites Through the Orchestrators

Run `packages/harness` tests through the package scripts, never a raw `bun test --coverage --parallel`:

```bash
cd packages/harness
bun test test/<domain>/<file>.test.ts
bun run test:ci
bun run test:coverage
```

`test:ci` and `test:coverage` spawn every Bun child with an injected `SYNERGY_TEST_HOME`/`SYNERGY_TEST_ROOT` and no `SYNERGY_HOME`, because Bun 1.3.x does not propagate preload environment into `--parallel` worker processes — a raw parallel/coverage run falls through to the real user home and writes fixtures into `~/.synergy/data`.

`src/global/index.ts` enforces this at module load: a test-entry process (`Bun.main`/argv matching `*.test.*`/`*.spec.*`, or `BUN_TEST_WORKER_ID`/`JEST_WORKER_ID` present) must carry the positive `SYNERGY_TEST_HOME` isolation marker, and is additionally blocked when the root is `os.homedir()/.synergy` or inside it (Windows paths normalized case-insensitively). If you see `TestHomeGuardError`, the run bypassed isolation: re-run through the package scripts or set `SYNERGY_TEST_HOME` to a dedicated test home. `SYNERGY_ALLOW_REAL_HOME=1` is the only escape hatch for a deliberate real-home run.

## Run Narrow to Broad

Core runtime commands run from `packages/harness`:

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
bun run --cwd apps/web i18n:extract
bun run localization:check
bun run --cwd apps/web build
```

Extraction must leave tracked PO catalogs unchanged, strict compilation must reject missing Simplified Chinese or invalid ICU messages, and the production build must keep non-English catalogs lazy while excluding development-only pseudo-localization. Exercise a Chinese cold start, rapid switching, catalog-load failure, `html.lang`, keyboard labels, and 375 px layout through an isolated Web/Desktop runtime.

Run the narrow failing test during iteration, then the affected package/domain suite, then `quality:quick`. Run the full suite when the change crosses shared abstractions, persistence, generated contracts, package publication, or release boundaries, or when the user requests it.

`bun run test:ci` is the CI-equivalent core suite. It runs planned shards sequentially in fresh Bun processes to bound resource and fixture accumulation without introducing cross-shard port or environment races. Set `SYNERGY_TEST_JUNIT_DIR` to emit one JUnit report per shard.

Coverage has a floor. `bun run coverage:check` enforces per-package line/function thresholds (the only metrics Bun 1.3.14 exposes in lcov) with an auditable exemption list in `script/coverage-exempt.json`. The rules:

- Cover product logic with real behavioral tests before exempting anything.
- Assert the complete asynchronous state being tested, not the first intermediate event. For time-budgeted maintenance, drive deferred passes through the public maintenance operation before asserting the final cap; preserve a bounded overall deadline.
- Register each new workspace package in `script/coverage-exempt.json` with a coverage command and thresholds. When adding nested test directories, verify that the package's coverage command includes them as well as its ordinary test command.
- Every exemption entry carries a `reason`; entries that match nothing, overlap, or cover more than 25% of a package fail validation.
- Bun 1.3.14 supports no ignore comments (`istanbul ignore`, `v8 ignore`, and `c8 ignore` are all inert), so whole-file exemption is the only exclusion mechanism. Do not add ignore comments expecting them to work.
- A source file never loaded by any test counts as 0% and fails the package — add a real test that loads it rather than exempting blindly.
- Subprocess behavior tests do not automatically contribute child coverage to the parent report. Pair real IPC acceptance with direct behavioral tests of worker-safe helpers in the instrumented process; keep both ownership and coverage evidence.
- Runtime-owning CLI tests must start with only the shared isolation preload, because the harness preload installs a Handle that maintenance must reject. Register these suites in the shared batch planner; preserve the original package's coverage report directory when selecting the fresh composition.
- For Solid wrappers exercised through a Vite-compiled DOM fixture, verify whether Bun attributes coverage to the emitted bundle instead of the TSX source. An exact-file exemption must identify the behavioral suite and this instrumentation boundary; keep directly testable logic measured separately.

Use [Development reference](../../../docs/reference/development.md) and [Open-source quality](../../../docs/operations/open-source-quality.md) for current command ownership. Do not invent a root `bun test`; the root script intentionally rejects that ambiguous command.

## Diagnose Failures

1. Re-run the narrow test alone and capture the first causal failure.
2. Check isolation leaks, stale generated files, timeouts, open handles, environment restoration, ordering, and platform assumptions.
3. Distinguish a product regression from a brittle expectation. Change the test only when the intended public contract is wrong or was asserted at the wrong level.
4. Do not skip, weaken, or quarantine a relevant test merely to make the gate green.

Directory-identity changes require a real OverlayFS copy-up check as well as ordinary temporary-directory tests. A newly created temporary directory already lives in the upper layer and cannot reproduce first-write metadata changes in an image's lower-layer directory. Keep catalog and coordinator identity checks on the same native primitive.

## Handoff

Report the invariant, test location, red/green evidence, commands run, pass/fail counts, unrun gates, platform limitations, and any remaining nondeterminism.

The root `coverage:check` command builds the public Plugin package through the dependency graph before instrumented suites run. Browser fixtures and Plugin Kit scaffolds resolve the published `import` entries; a clean checkout must not rely on artifacts left by another test or package-validation job.

Coverage is attributed to source owners after all commands in a complete root gate succeed. The gate deletes old canonical and shard reports before each command; failed or missing reports cannot contribute cross-package hits. Keep owner thresholds and exact-file exemption reasons when relocating code. Use `bun script/coverage-check.ts --package packages/<owner>` for a fresh local check; `--existing` is diagnostic only, keeps measurements package-local, and cannot certify command success or freshness. Never report a passing `test:coverage` command alone as a threshold pass.

CI workspace test concurrency must account for each package spawning native workers and browser/build processes. Run independent package suites serially on each shared runner because unconfined native write claims cross Runtime homes; preserve dedicated concurrency tests inside suites and parallelism between isolated runners. Retain the full suite graph. Failure diagnostics must reserve output space for both stream summaries; print failed coverage commands before the uncovered-line listing and retain bounded assertion differences across blank separators. Native watcher readiness probes must finish pending writes and observe their deletion before testing a neighboring file creation, so fixture events cannot be mistaken for a rename. Every new CI job must install its own executable and build prerequisites; runners do not share Chromium or workspace dist output. Keep coverage execution shards separate from complete-manifest threshold aggregation, and test that missing reports and partial aggregate requests fail. Preserve required check names through a fan-in that rejects failed, cancelled and skipped dependencies.

For pause/abandon transitions, hold descendant cancellation behind a promise and release the real session lease before repair finishes. Assert that queued work is not scheduled, concurrent pause writers retain one reason, and the final status event and API response agree with canonical state after abandonment.

For composer hold gestures, exercise the native pointer-down, partial/full hold, pointer-up and click sequence. Cover release while the request disables the button (no native click), then a new pointer or keyboard activation after completion. Assert draft preservation and request counts, not only a timer callback. For paused input, capture the first resumed provider request and assert the original root plus the new user direction. Verify accepted-input run identity independently from the new message identity, including CLI polling and cancellation. Pair pause/resume tests with fresh input after terminal run cancellation; the old cancelled root must not reopen or block the new task.

When integrating new tests after Runtime ownership changes, adapt every newly introduced fixture and subprocess entrypoint, including migration fixtures that open storage before registration is sealed. Register execution contributions in the fixture composition; vary the contribution's test-controlled outcome instead of replacing sealed registrations. Storage-engine tests without a product Runtime must use deterministic engine defaults, while native callbacks for an owned engine retain its creator's configuration.

For file writes, exercise exact-byte conflicts after restoring the original mtime, approval-time changes, cancelled waiters, real concurrent processes, parent symlink replacement, hard links and BOM/line-ending preservation. A timestamp-only assertion cannot validate overwrite safety. Browser fixture servers use ephemeral ports and explicit startup budgets so unrelated local instances and dependency warmup do not determine the result.

For Workspace upgrades, migrate a directory while it is absent, create a different directory at the same path, and verify that native access still requires explicit rebinding. Re-registering the location must not silently authorize the old identity. After rebinding, test both stale generations and another physical directory replacement.

Workspace coordination tests must cover two Runtime instances, overlapping and disjoint physical roots, root expansion, cancellation during admission and capacity resumption, stale lease release, and a live native process surviving its logical task. Exercise real Session and Cortex paths with one execution slot and parallel tools: a waiting child must not monopolize capacity, and one waiting tool must not release capacity still used by its active sibling. Assert physical claims independently of tool or turn completion. Drive active Workspace changes through `SessionManager.run`, not a manually acquired loop lease: only the former owns the native task context. Cover concurrent operations, stale generations, persistence failure, lost old directories, process survival and unresolved child/fork references.

For multi-stage operations that reuse a cancellation signal, test a real `AbortSignal.timeout` across completed child processes, native lock admission and cleanup. Attaching and removing listeners between stages must not disable the caller's deadline; keep an operation-wide cancellation bridge when required by the supported runtime.

Platform-only native implementations must contribute coverage from their actual OS runner. The macOS and Windows Workspace process shards use `script/native-workspace-coverage.ts` to inject an isolated home before spawning Bun, and uploads its LCOV at the same repository-relative path used by the Linux shards. Normalize Windows report paths before upload and keep the aggregate dependent on both jobs; do not lower package thresholds or classify executable native parents as unmeasurable.

Each package test command must prepare the native assets its own tests execute. A sibling package's build is not a prerequisite in an independent coverage shard. For native launch failures, verify that a subsequent real writer is admitted after missing assets or cancellation before supervisor ownership; checking only the launch error cannot detect a leaked lease.

For snapshot capture, verify exact bytes under text, ident and encoding attributes, same-size changes with restored timestamps, nested/global ignore precedence, file/directory transitions and literal symlinks. Exercise deep Workspace, object-store, index and transfer paths together on Windows; a successful Git initialization alone does not cover native reads or retained object access.

For native file previews, mutate size after metadata resolution and verify bounded failure, then read through an internal symbolic link whose target is longer than the link text. On Windows, copy file links, dangling directory links and junctions without changing their native type; compare preserved mode bits to the filesystem's actual mode rather than a POSIX-only fixture value.

For worktree cancellation, exercise an activated checkout hook and a native command on each supported OS. Verify full process drainage before admitting another writer, rollback of the owned unpublished directory, and retention after foreign lock replacement or a new commit. Pre-cancelled calls alone do not cover post-activation cancellation.

Native integration suites on the same host share write coordination even when fixture directories differ: unconfined processes can block an unrelated exclusive rebind. Retry only the expected busy result within a finite test budget when contention is incidental. Assert LSP connected status during an active query, and validate protocol replies plus native exit before a competing write; the caller promise may settle later while its use claims drain. Run repetitions in fresh Bun processes because the preload disposes its fixture root after a run.

For deferred work that captures Workspace identity, test origin selection changes, an explicit no-directory selection, persistent execution selection, missing or imported bindings, and the owning upgrade. Native file-watch tests must start without an open Session, survive rebinding and restart, and reject events from another Scope, Workspace or generation. Global item storage is separate from its file-event owner.

Cross-process filesystem coordination must remain shared when the processes have different temporary-directory environments. Exercise a held native claim with distinct `TMPDIR`, `TMP` and `TEMP`, verify exclusion, then verify admission after release; different fixture Homes alone cannot establish this property.
