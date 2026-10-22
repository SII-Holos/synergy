# Local Verification

Read only sections relevant to the current change. Search the headings and domain terms before loading unrelated cases.

- [Local Performance Experiments](#local-performance-experiments)
- [Run Harness Suites Through the Orchestrators](#run-harness-suites-through-the-orchestrators)
- [Run Narrow to Broad](#run-narrow-to-broad)
- [Diagnose Failures](#diagnose-failures)

## Local Performance Experiments

For retained string previews, verify backing-storage release rather than only output length. Use fresh Bun subprocesses with bounded synthetic Latin and two-byte input, synchronous full collection and previews kept live across the measurement. Preserve whitespace and UTF-16 truncation behavior separately, including unpaired surrogates. Keep heap probes in test fixtures or private experiments, never production handlers; an immediate sample after asynchronous `Bun.gc(false)` does not establish completed collection. A small reproduction identifies a retention mechanism, not its share of a live process's memory.

For startup and historical navigation, make work bounds the primary CI gate: forbid unrelated-owner reads and implicit complete execution snapshots, verify SQL plans as well as returned page sizes, and bound canonical header hydration by the requested messages. Shared CI runners use generous hang/deadline guards; never turn one developer machine’s latency into a tight CI threshold. Record process startup, usable composer, readable historical text, new input admission and worktree readiness separately. A health response, mounted turn container or loading animation is not application readiness. Keep model delay separate, retain failed samples, and report process-cold versus warm runs without claiming the operating-system cache was cold.

For installed-history acceptance, make a consistent independent data copy, relocate copied project/worktree bindings, use the local model fixture from `apps/web/test/fixtures/workbench/provider.ts`, and run `bun apps/web/test/fixtures/history/verify.ts <isolated-home> <loopback-server-origin> <private-manifest.json>`. The manifest supplies `sessions` (at least two `{id, scopeID}` targets), `projectScopeID`, the copied `projectDirectory`, and optional `timeoutMs` (default 60000). It must reference copied data and Git repositories only. The verifier measures readable text plus editable input, back/forward navigation, new input and worktree admission, rejects implicit complete execution summaries and HTTP server failures, and retains failed reports under the isolated home. Measure managed process launch separately; this verifier connects to an already running server. Keep private manifests, screenshots and reports out of commits.

For file-view acceptance, alternate public tools, history/undo, file services and actual formatter/LSP/plugin processes against the same bytes. Language fixtures must verify delivered text against their own filesystem; fixed diagnostic strings cannot establish target consistency. Hold a process callback at an observable barrier, edit old and new targets externally, switch the Session binding, and verify both physical files after the callback settles.

For multi-Workspace checkpoint changes, gate capture after index admission to prove real overlap and retain same-index, lifecycle-exclusion, queued-maintenance, failure-drain and identical-root reference regressions. Compare baseline and candidate in sequential isolated server processes against one frozen directory corpus; keep first-use and warm samples separate, validate Workspace-qualified checkpoint hashes and count incomplete captures. Measure pause request acceptance separately from execution drainage, Undo and the next provider admission. Use equivalent source layouts, alternate version order and record host load, memory pressure and swap alongside process CPU and RSS; retain unstable rounds rather than selecting only favorable samples. Place native fixture directories outside any active Workspace ancestor so lifecycle operations do not measure unrelated resource contention. A deterministic provider substitutes inference only; do not report it as live-model or Desktop acceptance. Keep raw fixtures private and record source, corpus and environment identities with resource costs.

For startup-to-conversation acceptance, test fresh, historical and large homes through durable input admission, canonical publication and model completion on the same fixture. Include multi-turn recall, duplicate admission, retry after pause, terminal historical roots and repeated Runtime restarts. Record the fixture's node, record, owner and artifact distributions; a large unrelated namespace proves cleanup scaling but does not establish retention owner-enumeration capacity. Keep machine-dependent timing thresholds in local reports, with correctness and recovery invariants in CI.

Budget live model calls at the provider boundary before forwarding them, counting auxiliary tasks and retries as well as user turns. Preserve interrupted attempts and explicitly record configuration variants. A soak report must identify the source revision and process restart boundaries; source edits do not reload an already-running parent's modules.

Benchmark adapters must pass the environment's `agent_process_env` to the agent invocation so restricted-network tasks retain the evaluator's inference egress. Test both proxy-enabled and ordinary environments while keeping provider credentials in temporary private files. Validate streamed requests through the proxy and recording path: a direct provider probe, an internet-enabled task, or a successful proxy HEAD request does not establish that the actual model transport works.

Test process signals through an actual child process after a deterministic provider readiness barrier. An in-process abort or timer preserves different async context from an operating-system signal; both paths must retain Scope ownership and terminal accounting.

Use the [benchmark workspace](../../../../benchmark/README.md) for model-backed task subsets and A/B evidence. Keep the evaluator, measured source, runtime recipe and dataset identities separate. Compare complete task-repeat pairs; preserve interrupted attempts and unknown accounting. Never substitute a static task-manifest check for an oracle/verifier execution result. Run the deterministic local-provider Docker test when changing preparation, the CLI bridge, cancellation, mounts or rollout capture. For stream/recording changes also run `SYNERGY_ROLLOUT_LONG_STREAM=1 bun test --cwd packages/harness test/session/rollout-long.test.ts`; independent CI workers own its completed, cancelled and failed outcomes, and the test aggregate requires all three. Keep each outcome in a separate process so a timed-out test body cannot overlap the next sample; retain the completed 30 MiB byte-integrity load with 32 KiB chunks; select `SYNERGY_ROLLOUT_CHECKPOINT_STRESS=1` explicitly for the historical 1 KiB checkpoint pressure and use smaller received payloads for cancellation and failure, preserving report persistence, archive verification, usage and fixture-cleanup progress. Size the test and outer job deadlines to include deletion of the retained evidence, with job time remaining for process cleanup. Apply the benchmark’s fixed three-hour budget to solving, reference execution and verification; preserve failed rewards and historical evidence. Inspect exporter exit/signal/deadline, archive validation, recording coverage, unknown usage and owned Docker residue independently. Test terminal-evidence reconciliation before allowing resume to schedule another paid attempt. Container-created mode-0600 accounting and mode-0700 ledger directories are not host-readable on Linux until Pier hands logs back. Test that boundary without widening permissions; inspect active evidence inside the verified owned container.

For concurrent-session performance changes, use the [production performance fixtures](../../../../apps/web/test/performance/README.md). Establish behavioral bounds before timing: one file-status request per Workspace generation, no hidden-consumer refresh, a finite owner-scoped execution revision cut, owner-only gap repair, root-only context headers, shared cancellation and one-second progress/depth aggregation. Compare baseline and candidate on the same device sequentially, counting work by affected category instead of reapplying a past percentage target. Separate real deterministic-model execution from synthetic stream throughput; report admitted, active and queued tasks and pressure limits. Preserve six Session residents and eight panel residents. A cold navigation is ready only when target body text is readable and its composer accepts input; verify drafts, scroll, selection and disclosure across warm switches and reconnects. Retain failed panel continuity reports even when both revisions fail.

For Rollout transport/storage diagnostics, run `bun packages/harness/script/benchmark-rollout.ts` with `SYNERGY_BENCH_CONCURRENCY=8` or `16`; `SYNERGY_BENCH_CHUNKS` controls stream length. It owns a disposable Home unless `SYNERGY_BENCH_FIXTURE_HOME` names a consistent private copy with a `.synergy-performance-fixture` marker. `SYNERGY_BENCH_SOURCE` selects the measured checkout, including its independently installed dependencies. Run revisions sequentially on identical copies. This harness leaves historical execution inert and verifies retained bytes, sampled historical replay, cancellation and failures; its loopback health endpoint is not product readiness. Report record mutations, SQL transaction attempts, archive blocks, projected frames and retained encoding bytes separately. Keep copied-data measurements out of CI and use the production browser fixture for rendered readiness.

## Run Harness Suites Through the Orchestrators

Do not pass `--no-orphans` to a test batch or inherit `BUN_FEATURE_FLAG_NO_ORPHANS` into its environment. Bun propagates this watchdog through nested Bun processes, killing intentionally detached work and recovery supervisors before their owning implementation can settle them. Keep explicit fixture cleanup and process-drain assertions; a runner's automatic kill is not evidence that product ownership worked. The shared runner's detached-process regression verifies the interval after launcher exit and before the fixture releases its worker.

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

Harness runtime commands run from `packages/harness`:

```bash
bun test test/<domain>/<file>.test.ts
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

Select batched Web, UI and package suites with `SYNERGY_TEST_FILES` containing a JSON array of inventory paths; their package scripts do not consume positional file arguments. Run direct `bun test` from the owning package directory. When product labels change, update real-host accessibility locators while retaining the persistence and interaction assertions.

Iterate with the narrow failing test, then run `verify local` once the change is ready for publication. Broaden to a complete affected package with `verify coverage --package` for coverage-policy, instrumentation or substantial test removal; broaden other checks only when evidence requires it. CI owns the full selected matrix, including shared abstractions, persistence and release acceptance; do not duplicate that matrix locally by default.

`bun run test:ci` runs the complete core inventory in fresh sequential batches. `test:coverage` uses the same executor with instrumentation; CI executes that inventory once and requires JUnit, lcov and timing evidence for every selected batch. See [CI verification](../../../../docs/operations/ci.md) for `ci:plan`, `ci:run`, `ci:verify`, affected selection and diagnostic selectors. Assign Harness, Web, Presets, UI and Local Runtime to 4, 4, 4, 2 and 2 measured file-weight partitions, preserving complete isolation batches and special isolated files; each process owns its Home, fixture root and database. Bind ports dynamically in fixtures; distinct runners provide host isolation.

Coverage has a floor. `bun run coverage:check` enforces per-package line/function thresholds from Bun lcov reports with an auditable exemption list in `script/coverage-exempt.json`. The rules:

- Cover product logic with real behavioral tests before exempting anything.
- Assert the complete asynchronous state being tested, not the first intermediate event. For time-budgeted maintenance, drive deferred passes through the public maintenance operation before asserting the final cap; preserve a bounded overall deadline.
- Register each new workspace package in `script/coverage-exempt.json` with a coverage command and thresholds. When adding nested test directories, verify that the package's coverage command includes them as well as its ordinary test command.
- Every exemption entry carries a `reason`; entries that match nothing, overlap, or cover more than 25% of a package fail validation.
- Declare exclusions through the reviewed manifest; do not use inline coverage-ignore comments as an alternate policy.
- A source file never loaded by any test counts as 0% and fails the package — add a real test that loads it rather than exempting blindly.
- Subprocess behavior tests do not automatically contribute child coverage to the parent report. Pair real IPC acceptance with direct behavioral tests of worker-safe helpers in the instrumented process; keep both ownership and coverage evidence.
- Runtime-owning CLI tests must start with only the shared isolation preload, because the harness preload installs a Handle that maintenance must reject. Register these suites in the shared batch planner; preserve the original package's coverage report directory when selecting the fresh composition.
- For Solid wrappers exercised through a Vite-compiled DOM fixture, verify whether Bun attributes coverage to the emitted bundle instead of the TSX source. An exact-file exemption must identify the behavioral suite and this instrumentation boundary; keep directly testable logic measured separately.
- When a Solid component can also run in Bun's DOM harness, use the existing Solid Babel loader in an isolated browser-conditioned suite and assert its real actions, reactive state and disposal. Verify the original source paths appear in LCOV; an import-only probe is not behavioral coverage.
- Shared UI source-render tests use `packages/ui/test/support/solid-dom.ts` and register in both `isolated` and `browserOnly` in the package runner. The helper binds a fresh JSDOM and transforms TSX with source maps; close the DOM after disposing mounted roots. Keep layout, Canvas, Worker and native selection assertions in real-browser suites.

Use [Development reference](../../../../docs/reference/development.md) and [Open-source quality](../../../../docs/operations/open-source-quality.md) for current command ownership. Do not invent a root `bun test`; the root script intentionally rejects that ambiguous command.

## Diagnose Failures

1. Re-run the narrow test alone and capture the first causal failure.
2. Check isolation leaks, stale generated files, timeouts, open handles, environment restoration, ordering, and platform assumptions.
3. Distinguish a product regression from a brittle expectation. Change the test only when the intended public contract is wrong or was asserted at the wrong level.
4. Do not skip, weaken, or quarantine a relevant test merely to make the gate green.

Directory-identity changes require a real OverlayFS copy-up check as well as ordinary temporary-directory tests. A newly created temporary directory already lives in the upper layer and cannot reproduce first-write metadata changes in an image's lower-layer directory. Keep catalog and coordinator identity checks on the same native primitive.

When testing unavailable or replaced project directories, exercise historical Session reads, Scope bootstrap and path metadata through the mounted HTTP middleware as well as file-access refusal. Include projects opened through a symbolic link or directory junction: Scope paths and canonical catalog locations can differ. Verify that metadata reads preserve the saved physical identity and generation; successful migrations and direct domain reads do not establish that the application can reopen history.

For long browser suites, split independently isolated behavior domains without dropping parameterized cases. Reuse immutable production fixture compilation through the existing input-addressed helper; each batch retains its own page, Home and cleanup. Compare the complete before/after test-name inventory and actual cold/warm times. Native keyboard acceptance must observe the intended scroll and focus state before sending input; module-load latency is not a readiness barrier.
