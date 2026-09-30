---
name: testing-guide
description: Design, write, run, and diagnose Synergy tests with Bun, temporary Scope isolation, deterministic fixtures, and behavior-first assertions. Use for TDD, bug regressions, feature tests, migration tests, flaky tests, coverage, package tests, frontend tests, and selecting verification gates.
---

# Test Synergy Behavior

## Avoid concurrent artifact mutation

When upgrading Bun, validate native FFI with JIT enabled and disabled, including real process exit and PTY bytes. Preserve asynchronous cancellation failures in a child-process regression; a synchronous `try` cannot observe a rejected cancellation promise. Test Home-guard subprocesses from their own fixture directory: an empty explicit config can still discover the repository's working-directory preload and invalidate the intended environment.

Local acceptance fault injectors must match the intended request and an observed stage; auxiliary model calls, empty argument deltas and untriggered hooks are not coverage. Preserve upstream and delivered bytes separately when truncating a stream, and drain request journals on cancellation before reporting usage. For persistence, independently observe the same owned namespace, fail actual database writes or connections, retain a sealed export before cleanup, and keep cloud-adapter protocol fixtures distinct from real-provider deployment acceptance.

For Workspace contention, explicitly inject a managed mutation when testing writer admission. Raw Bash commands retain resource use without writer exclusion; shared-child cancellation scenarios must observe both commands at a physical barrier before cancelling and rebinding one. Include resource-use roots when checking residual claims, and test imports into multiple missing directory levels so parent creation stays inside the admitted mutation.

Cross project-folder changes with the scheduled janitor: retain a dirty bound task in a removed source repository while reclaiming clean candidates in both historical and current repositories. Check physical bytes and the persisted binding after the scheduled sweep drains.

Distinguish model disconnects from watchdog timeouts. Hold an actual upstream response until the client aborts, and require the matching first-byte or idle watchdog metric before counting the phase. Complete real model work before and after the timeout sequence and independently count any earlier tool side effect. Match delegated fixture roles by an unambiguous identity token; descriptive text appended by the model must not prevent observing the real child task.

Do not run `quality:quick` alongside browser suites or development builds in the same worktree. Its package checks rebuild exported artifacts, and format scanning races temporary DOM fixtures being removed. Run those checks sequentially; if a suite reports a missing generated module during concurrent rebuilding, finish the build and rerun the affected suite before changing application behavior.

## Workbench Presentation Acceptance

Use the isolated provider and synthetic-data workflow in `develop-synergy` for the real new-task → first-send → reply → switch-and-return path. Keep component fixtures for failure injection and geometry, but do not label them end-to-end or real-provider evidence. Register browser suites with their owning serial runner. Do not run a narrow suite alongside that runner when they share a Vite fixture root or dependency cache; finish one run before starting the other. Measure the actual Composer, status footer, floating inbox and menu bounds in both wide and narrow chat panes; a full-width browser can still contain a narrow pane. Allow subpixel rounding rather than exact floating-point width equality. Native IME, real 200% zoom, reduced motion and visual focus each need explicit evidence; pasted text or a resized viewport is not a substitute.

CI `package:check` builds its own package closure and runs on the separate contracts runner. Keep rebuilding gates apart from suites consuming workspace `dist`; isolated Homes do not isolate the checkout's compiled files.

## Local Joint Acceptance

Identify the intended foreground provider request independently of streaming: title and other auxiliary calls can also stream, and journal enumeration is not request chronology. Test both request orders and reject a missing first attachment body even when a later tool response contains its content.

Product scenarios select built artifacts explicitly: `artifacts.web` names the production Web directory; `artifacts.desktop` contains `directory`, relative `entry`, `electronDirectory` and relative `executable`. Directory inputs freeze every file, executable bit and internal link, rejecting dependencies outside the artifact. Freeze the whole Chromium application with an additional named input as well as its selected executable. Keep build output immutable during a run; rebuilding requires a new plan.

Re-read the clean source identity before and after each scenario. A source identity captured once at command admission cannot detect edits or a changed checkout before later child workers load modules. Stop later scenarios on mutation and retain the failed attempt; do not publish a successful result under the original revision.

Select `artifacts.core` and `artifacts.full` installation seeds for installed CLI, SDK and embedding acceptance. Execute copied observer workers outside the checkout, resolve public imports into the selected closure, validate the product generation inventory and inspect actual file bytes and child exit. Exercise native terminal output through both embedded profiles. Await durable input completion after the foreground loop returns; auxiliary recording can still be settling. Opt-in fixture regressions use `SYNERGY_ACCEPTANCE_CORE`, `SYNERGY_ACCEPTANCE_FULL` and `SYNERGY_ACCEPTANCE_PREVIOUS`.

For the one current-dev upgrade fixture, `artifacts.previous` records its installation `directory` and exact Git `source`. Build that artifact from the declared revision, create a fresh synthetic Home, close it and preserve a complete private copy before reopening with the final artifact. A legacy writer may reject the host's newer shared claim ledger: isolate the old writer's exported lock-directory function and inject the new reader's public Workspace coordinator with the same dedicated fixture directory. Keep that fixture exclusive and verify the old ledger upgrades and drains; never rewrite the shared host ledger to accommodate an old binary. The installed package bytes stay unchanged. This verifies sequential upgrade, not mixed-version concurrent execution.

Exercise the real composer, resource dialogs and Desktop shell with a fresh user directory. Select the declared primary agent through the UI and verify the submitted message. Confirm pause/cancel against actual processes and stored input state, refresh saved drafts, and interrupt the real event WebSocket while work continues. Seed pagination history through canonical task roots and mark it as synthetic; seeded history does not count as model use. Cross failed-input presentation with a healthy successor and compare previous messages after recovery. Local fixture-provider regressions use `SYNERGY_ACCEPTANCE_WEB`, `SYNERGY_ACCEPTANCE_DESKTOP`, `SYNERGY_ACCEPTANCE_ELECTRON` and `SYNERGY_ACCEPTANCE_CHROMIUM`; paid requests remain exclusive to explicit live runs.

Cross product resource selection with an object Workspace and remote compute. Create the remote Environment through its profile button, verify no container exists until the first composer-directed system call, then inspect physical remote files and the side-effect count. Reload and verify both selected resources before using the product's save-and-release action; compare saved bytes after the container disappears. The Desktop remote fixture additionally requires `SYNERGY_ACCEPTANCE_REMOTE_SETTINGS`.

Check the shared native claim ledger before beginning local experiments. A drained process can still hold a deliberate durable reservation after a failed finalizer; process exit alone does not authorize deleting it. Keep the failed attempt and its accounting, verify ownership and physical drainage, then recover the original operation or use its retained recovery reference. Never clear the host ledger wholesale or let a contaminated rerun count as fresh acceptance. Stop and release fixture processes inside the Runtime context that owns them before disposing that Runtime.

Use Presets' opt-in `bun run acceptance --help` for cross-domain local experiments. Declare risks, preconditions, operations, observable fault barriers and independent oracles before running. Freeze a clean source revision, the executing Bun binary, dependency lock, model catalog/configuration and artifact inventories with `plan --case <ids|all> --out <private-directory> --settings <settings.json> --input <name=artifact>`. Keep model credentials in explicitly selected private files outside the repository; never copy an entire personal Home. `run --out <directory>` executes only declared cases. `resume` preserves prior attempts; repeating a failed or interrupted case requires `--retry <ids> --reason <explanation>` and creates another attempt. `report` rejects missing, changed or incomplete evidence and keeps model quality separate from system correctness. Review all three evidence classes: product, external physical state and transport. A script that exits successfully without triggering the target behavior is uncovered. Preserve request journals independently of scenario success, including auxiliary calls, retries, cancellation and unknown usage. When a scenario opens several isolated Runtime homes, explicitly share its recording directory and verify the aggregate ledger across those variants. Never combine different frozen revisions into one acceptance verdict.

Settings explicitly select `providerID`, `modelID`, HTTPS `upstream`, `apiKeyFile`, `modelCatalog` and a `config` object containing ordinary product configuration. `deadlineMs` bounds state barriers. Mixed-media cases require a `chromium` executable, included in the input freeze. Remote cases require `remote.endpoint`, `hostname`, an immutable `sha256:` image ID and `engineTLS`/`executionTLS` objects containing private `cert`, `key` and `ca` file paths; all certificate bytes are frozen. Use a dedicated Docker daemon with no host filesystem sharing. The controller receives the same saved resource profiles used by the product, with certificates registered in its isolated Secret Vault.

Keep recognition answers outside model-accessible files and expose only the tools needed for the measured input path. Check that an intentionally wrong fixture response cannot pass; looking up a stored answer is not recognition. Validate the frozen model catalog before startup, including required provider entries, and pass its path to child processes so a rejected partial catalog cannot silently select bundled defaults.

Point source workers' `MODELS_DEV_API_JSON` at the external frozen catalog before importing Runtime modules. A copy inside the Runtime cache can be deleted by normal cache-version initialization; verify a catalog-only model after an actual process restart instead of assuming that a successful first call proves restart configuration.

Installed modules use their build-time catalog snapshot. Acceptance must also merge the frozen provider definition into the existing configuration contract, preserving explicit model overrides, so fresh source and installed homes select the same capabilities without changing package bytes. Exercise a catalog-only fixture model absent from the installed snapshot through CLI, SDK, embedding and the upgrade path.

Run the deterministic driver checks with `bun test test/acceptance` from Presets. Set `SYNERGY_ACCEPTANCE_REMOTE_SETTINGS` to an isolated settings file to activate the real remote controller-death regression. Ordinary CI never calls the paid provider. Keep source-integration preflight reports separate from acceptance on merged `dev`; a preflight can expose a defect while merge reviews are pending, but cannot satisfy the final-version gate. Preserve the original attempt before fixing a driver or product failure. Physically verify owned containers, networks and volumes after successful reclamation; preserve unsaved resources after a failed experiment until their unique bytes are recovered.

For permission acceptance, observe file bytes at the pending decision before replying, then verify rejection and authorized success separately in each control profile. Distinguish Workspace containment and OS read-only failures from policy denial. Linux sandbox temporary directories can be private mounts; an exit-zero write there does not prove that the selected allocation's original directory changed. Match observations to the actual target and wait for observable resource-use drainage before testing detachment.

For transport shutdown changes, exercise a server-initiated WebSocket close through a real full Runtime in a child process. Observe complete terminal output, Runtime closure and process exit separately; a close event or completed tool is not proof that the HTTP server drained. Prepare the native PTY with `bun packages/local-runtime/script/build-pty.ts` before the focused Presets shutdown test. CI restores that helper from its verified build artifact.

## Review Test Value and CI Cost

1. Before adding a scenario, inspect nearby coverage and name the observable behavior, the real failure it prevents, and what existing tests leave uncovered. Extend a suitable existing test when it already owns that behavior. File size, assertion count and coverage percentage alone do not establish value.
2. Review the affected old tests in the same change. Delete obsolete behavior, consolidate duplicate coverage, and replace assertions about source strings, callback names, incidental structure or fixed style values with observable results where needed. Record what was retained, combined or removed and why; there is no quota for adding or deleting tests.
3. Put shared behavior at its lowest useful level. Keep adapter-specific integration at each adapter; add model, protocol, platform or outcome combinations only when they protect a distinct failure. Reuse immutable preparation while retaining separate mutable Homes, processes and DOMs.
4. When replacing expensive acceptance, demonstrate that the retained test rejects a relevant fault such as a missing file edit, lost recording or failed continuation. Preserve public lifecycle, installation, migration, cancellation and recovery checks and coverage floors. Repetition and long sessions need an identified size, duration or accumulation failure; duplicate historical stress belongs in an explicit diagnostic.
5. Measure preparation, execution, cleanup, upload and queues for changes to expensive fixtures, matrices or CI. Compare equivalent cold and warm runs, report the incremental cost and its useful coverage, and update task weights from observed time. Diagnose flakes at their observed stage; blanket retries, longer sleeps and hidden skips cannot justify growth. Use [CI cost policy](../../../docs/operations/ci.md#维护验证成本) when reviewing a longer critical path.

## Define the Invariant First

When a dedicated CI task activates opt-in tests, declare its mandatory scenario names in the verification catalog. Verify the actual JUnit report rejects skipped or missing scenarios; process exit status cannot prove that an external capability was exercised. Cover both source and test-only changes in affected planning.

1. State the observable contract and the failure that would violate it.
2. For a bug or new behavior, write the smallest failing test before the implementation. Skip a new test only for a pure refactor whose existing tests already cover unchanged behavior.
3. Assert public results, state transitions, emitted contracts, permissions, or recovery behavior. Avoid source-text assertions, private call counts, and snapshots of irrelevant structure.

Seed large SQLite fixtures inside a transaction so per-row durability flushes do not dominate correctness test deadlines. Preserve the dataset size and the migration, restart, and failure boundaries exercised by the test.

Compare directory snapshots as sorted paths or sets when asserting unchanged files; filesystem enumeration order is not a product invariant.

For independently loaded UI groups, wait for the observed group itself before asserting its result. Another group's rendered content cannot establish completion; retain checks for failure isolation and retry without imposing response ordering.

Prepare durable fixtures before starting a short runtime deadline; for Cortex timeout tests, enqueue follow-ups between `Cortex.prepare` and `Cortex.start` rather than racing their writes against the timer.

For persisted cooldowns and retry deadlines, advance a controlled clock at the failure-response boundary and verify both the recorded timestamp and the exact policy duration. Cover second boundaries explicitly; an upper bound derived before asynchronous work must not replace the time at which the policy applies. Restore the clock even when an assertion fails.

For worktree lifecycle changes, exercise concurrent name selection after admission, setup descendants, unregistered directory users, active-turn selection/removal, cancellation and deferred unlock. Verify concurrent tools in sibling and shared Workspaces while real unrestricted commands are still active. Test LSP continuity, exact formatter preconditions, save conflicts after response loss and stale checkpoint recovery without replay.

For automatic worktree cleanup, fail native admission and the final Git removal after eligibility succeeds with an idle bound Session. Assert original binding, registry membership, bytes and activity survive, and a later candidate still progresses. Separately fail binding persistence after successful deletion and verify the next sweep reconciles the retained registry entry.

For shared claim ledgers, exercise a legacy reader rewriting newer records. Missing observation fields must remain unknown and cannot restore exclusive authorship or authorize undo; preserve retained resource ownership.

For process-overlap changes, bind a real owned native tree before admitting a competing writer; a PID-only fixture does not exercise production tree ownership. Cover unavailable native inspection, unknown PID identity and verified PID reuse. After native drainage, validate retained checkpoint authority before and after a later isolated operation, then release explicitly after saving.

For retirement changes, overlap cleanup in independent repositories and include concrete Git/cache mutations outside the retired directory. Verify that broader ownership is reserved before directory exclusion, that nested writes cannot wait on their own lifecycle claim, and that undeclared expansion fails before queuing. Capture ownership state for an unexplained timeout; a green rerun alone does not identify its cause.

For process-backed write evidence, test the interval after native exit but before archive completion: an overlapping writer must remain excluded, disjoint roots must proceed, and finalizer failure or Runtime death must not leave a completed process permanently occupied.

Inject native control-socket resets both before and after the completion receipt. Preserve exact output and exit status after acknowledged completion; a lost supervisor must still report uncertain ownership and retain its claim, with any earlier transport failure preserved as a cause. Test dropped WebSocket output and terminal-status frames separately, including cursor replay after the connection closes.

Windows shell regressions must explicitly select `cmd` when testing its quoting contract; the runner's default can resolve to another interpreter. Cover a quoted executable with multiple quoted arguments, and report early command exit before waiting for a descendant readiness marker.

Await native-I/O rejection before applying a synchronous error matcher in Windows tests. Capture the rejection through `await promise.then(() => undefined, (error: unknown) => error)`, then assert its type and content; an unexpected resolution must still fail. Bun's asynchronous `toThrow` matcher can block database progress on Windows; see [Bun issue 19130](https://github.com/oven-sh/bun/issues/19130). Preserve the real operation and its deadlines when changing the assertion.

When a handler test exercises a nonzero `process.exitCode`, snapshot it as `process.exitCode ?? 0` and restore that numeric value in `finally`. Bun 1.3.14 ignores assignment of `undefined`, so verify the test process exit status even when all assertions pass.

For admission wrapped in execution-capacity waits, inject cancellation and a thrown resume error after the Host returns a lease. Verify cleanup for independently retained file pins as well as task-owned claims; a successful acquire does not imply the surrounding wait returns successfully.

For non-blocking and ordering contracts, hold the downstream operation behind an explicit promise and assert the upstream result while it remains pending. When asserting that an inbox item remains queued after an operation that schedules a wake, hold a real SessionManager loop lease on the worker; clean up its queued work before releasing the lease so a delayed wake cannot escape the fixture. Drive the public wake before queue assertions and after cleanup to cover both scheduling orders without sleeps. For cross-process lock tests, hold the first owner behind an explicit parent release message and retain readiness as a promise; do not poll for a transient exact log snapshot. Release the owner only after the contender reports actual acquisition contention, not merely startup or intent to call the lock API. Drain child stderr and register process cleanup before awaiting startup. Use a generous test-framework timeout only to detect deadlocks, release the barrier in cleanup, and avoid wall-clock performance thresholds in instrumented correctness suites. Do not wrap correctness-only completion signals in shorter `Promise.race` timers: filesystem and worktree startup contention can exceed those incidental budgets on CI.

A native readiness wait must also observe operation settlement: preserve early failures, report completion before readiness, and close its observer before cancelling and draining the owned operation. Publish readiness payloads atomically and validate positive PIDs before liveness checks: file existence can precede its write, and an empty payload coerces to process group zero. Test supervisor startup failure with a real early-exiting launcher; retain bounded stderr and exit identity, and prove that the target command did not run and its unactivated claim was released. Intentionally suspended native cancellation fixtures must reserve cleanup time within their existing test budget; the framework's hard timeout can kill the supervisor before its completion receipt is written.

Also inject a supervisor error after command activation and let the real root exit normally. A drainage promise and exit code zero cannot replace the process error channel; callers must preserve that error while still draining ownership before returning.

Separately exercise a real child closing stdin while unread input is queued, then emitting more stdout and stderr. Input rejection must reach the input stream without terminating the command; require its actual exit, complete output bytes and released claim. Keep output and control transport failures fatal.

When a public operation returns a typed in-progress outcome at its foreground budget, correctness tests must await its documented completion path before asserting durable results. Exercise that outcome with an explicit held-operation fixture; do not raise the product deadline or swallow unrelated failures.

## Choose the Lowest Useful Level

For byte-bounded queues, hold a worker busy and admit several individually valid requests across scheduling lanes. Verify aggregate rejection and exact byte release on dispatch, queued cancellation, startup failure, and shutdown; a single oversized request does not exercise aggregate admission.

- pure function/schema: inline data and direct calls
- tool/domain behavior: real implementation plus isolated temp directory and Scope context
- persistence/migration: real storage, fresh-install and upgrade fixtures, restart/readback where relevant
- route/SDK: call the route or generated client contract
- session/LLM loop: real session state with deterministic provider/model fixtures
- Web/UI: component/context behavior plus the smallest browser or integration check needed
- external agent adapters: execute a deterministic protocol fixture as a real child through the public Adapter interface; verify stdin, event framing, tool errors, usage, thread isolation/resume, credential filtering and shutdown rather than only private argument builders
- package/release: build, pack, and validate the published artifact rather than source layout alone. Core owns standalone tool execution and installed-package task completion; full owns the six result cases, the complete import/export check and component lifecycle described in [CI verification](../../../docs/operations/ci.md). Help and health checks do not validate product lifecycle delegation.

After splitting a package, evaluate each new owner against aggregate coverage; the former combined percentage can hide an uncovered protocol or lifecycle branch. Exercise worker registrars in an isolated Runtime context as well as through real IPC. Keep process-only coverage exclusions limited to exact entry files with named executable tests; do not exclude reusable registrars or lower the new package floor.

Exercise a library's public package entry in its behavioral embedding tests, even when the same file also starts a CLI. Child-process bootstrap tests cannot establish the in-process import contract or contribute that entry's parent-process coverage.

Inspect two nearby tests and `packages/harness/test/support/preload.ts` before introducing a new harness pattern.

Importing an App `src/components/**` module directly from `bun:test` needs its module-load side effects satisfied first: `mock.module("@/locales/en/messages.po?lingui", () => ({ messages: {} }))` for the catalog, because the `.po?lingui` module is not Bun-loadable, and a stub for anything reaching `@ericsanchezok/synergy-ui/icon`, whose `lucide-solid` `Dynamic` chain throws "Client-only API called on the server side". Prefer extracting the logic under test into a plain module (a classifier, a resolver, a projection) and testing that directly; reach for the mocks only when the component's own wiring is the subject.

The Web runner's `browserOnly` list selects module conditions, not process isolation. Suites that replace shared router, server, SDK or theme modules must also appear in `isolated`, so their mocks cannot affect lazy imports in sibling suites. Check both lists when a suite passes alone but fails with missing exports in a CI batch.

Place every test under the owning package's `test/` directory, mirroring the relevant source domain when that helps navigation. Place repository-level script and policy tests under the root `test/` directory. Never cascade `*.test.*` or `*.spec.*` files beside implementation files in `src/`, `script/`, or another source directory. Run `bun run test-layout:check` when adding or moving tests.

For localized UI behavior, use a real Lingui `I18nProvider` with minimal English and Simplified Chinese messages. Assert visible text and accessibility labels after a reactive locale change; do not mock translation calls to return IDs because that hides missing catalogs and stale module-load translations. Keep plugin-author, user, LLM, path, identifier, and raw-error pass-through in the same boundary test as translated host chrome.

## Use Real Isolation

Vite fixtures pass a nonzero loopback port from the shared `fixturePort()` helper; Vite's `port: 0` selects its default port and collides across otherwise isolated package processes. Close the owning server before deleting its fixture. Keep correctness waits tied to the configured behavior and observable settlement; the test framework bounds a hung test, while an additional short race can reject valid completion under instrumentation.

Per-session recovery tests must migrate only their owned session fixture. Exercise the global migration runner separately with a dedicated home; a process-wide migration scan can encounter intentionally incomplete records from unrelated suites or earlier shards.

Use `tmpdir()` and `ScopeContext` instead of mocking Storage, Session, or the filesystem. The preload-managed `SYNERGY_TEST_ROOT` contains temporary fixtures for process-level cleanup, so do not move fixtures back to unmanaged operating-system temp paths or delete them while Scope-owned asynchronous work may still reference them. Create an explicit package Runtime fixture and run test bodies and relevant hooks inside `runtime.run()`. Set environment overrides before opening; changing `process.env` after startup does not change a captured Host. Close the fixture before deleting its home. Keep registration in its composition, never at module evaluation. Do not enter `describe()` through an asynchronous Runtime context; Bun collects callbacks before running them. For parameterized tests capture a ready module fixture with `bind`, or enter a per-test fixture when the callback runs. A module-level replacement of a process global — `globalThis.fetch` above all — is visible to every sibling file in the same shard process: capture the original before installing the replacement and restore it in `afterAll`, because a per-test `finally` that re-reads `globalThis.fetch` restores the replacement, not the original. Honor abort signals and dispose processes, Browser pages, servers, and timers.

Cancellation tests must cover the interval after execution ownership releases but before asynchronous ledger reconciliation finishes, preserving interrupted call evidence and the terminal cancellation result.

Capture process-global loop observations by their owning Session ID and assert the target Session's requests. A single last-call variable can be overwritten by unrelated background work; exercise an independent Session and drain the owned Cortex task before restoring loop mocks.

Electron fixtures should launch the resolved Electron executable rather than the npm CLI wrapper so timeout signals reach the owned application. Include cold startup and teardown in the test budget, and retain phase diagnostics on failure.

Browser acceptance tests that combine history navigation with connection recovery must validate the final canonical message state when recovery removes a pending navigation control. Keep errors for controls that remain present, require the latest message to be rendered, and retain reconnect and bounded-window assertions under delayed responses.

Process lifecycle assertions must wait for the observable completion state within the configured startup/shutdown deadlines, not a fixed number of millisecond sleeps. Keep generation, PID, cleanup and recovery-evidence assertions, and dispose owned processes in `finally`. For persistence jobs, reserve cleanup time within the package test deadline and cancel/drain unfinished jobs before restoring dependencies or deleting their database. Installed binary jobs must align `SYNERGY_BUILD_TARGETS` with the runner ABI and staged required helpers; `--single` alone can select both GNU and musl on Linux. Installed artifact correctness tests must budget cold generation verification, native worker startup and every import/export subprocess together. Keep explicit timeout scenarios short, give ordinary fixture turns enough time for the complete installed graph, and record command timings without asserting a performance threshold. Cancel and drain owned children before the framework deadline so a timed-out body cannot overlap the next fixture.

Runtime shutdown tests must observe a real child's readiness and hold it alive until shutdown; a child that exits on its own timer cannot establish shutdown ownership. Check native liveness before closing and absence afterward, preserve early-exit errors, and report the last startup or cleanup phase when the fixture's cancellation budget expires.

For native stdin forwarding, hold the destination write acknowledgement before declaring EOF, then verify empty input, late EOF, failed writes and fragmented input across pipe capacity with exact length and hash checks. Compare direct child, socket forwarding and installed worker paths when diagnosing truncation; a socket data event or successful process exit does not prove complete child input. Keep cancellation and unread-output drainage checks alongside the input regression.

When injecting a failed resource close, retain the underlying handle and close it during fixture cleanup. The simulated failure must remain observable to the caller without leaving garbage collection to release the real resource.

Provider/model tests use the package preload configured in `bunfig.toml`; `packages/testing/src/preload.ts` seeds the model catalog. The preload writes the pinned `packages/testing/fixtures/models-api.json` fixture to `cache/models.json` under `SYNERGY_TEST_HOME` so the runtime disk-cache path resolves deterministically, sets `MODELS_DEV_API_JSON` to that cached path so the build-time macro and direct macro tests resolve the same fixture, and sets `SYNERGY_DISABLE_MODELS_FETCH=true` to suppress background network refresh. Update the fixture deliberately; never make deterministic tests depend on the live model catalog or real API keys.

Core binary builds also default to that pinned fixture. Test build behavior through `script/release/shared/build/models-catalog.ts`: the selected catalog must satisfy the runtime schema and contain non-empty OpenAI, Anthropic, and Google providers before compilation. Ordinary local builds may use `MODELS_DEV_API_JSON` as an explicit override; release builds must force the repository-pinned snapshot so network and build-machine cache state cannot alter the artifact.

For embedded Runtime lifecycle changes, repeat real open/task/close cycles in one process and verify resource release as well as port reuse. Native HTTP handlers can retain their creation context after the server stops; release handler references outside the Runtime after requests and sockets drain. Check per-instance database maintenance timers at closure. Use a focused reachability regression for a demonstrated retention defect; RSS alone includes allocator caches and cannot prove ownership release.

Cold-cache tests construct a fresh Runtime and an unseeded isolated home. Module imports and the test preloader do not populate another instance’s caches. Use a subprocess when process startup, native callbacks, signals, installed artifacts or worker protocols are the contract. Never remove the positive test-home isolation marker.

Compile standalone Bun artifacts in a fresh `bun build --compile` subprocess, drain both output streams, and assert its exit code before exercising the executable. In-process compilation after plugin builds can reuse invalid compiler state on Linux; retain the artifact behavior assertions and run the combined suites under coverage. See the [standalone compilation decision](../../../docs/decisions/implemented/testing/2026-09-23-isolate-standalone-plugin-kit-compilation.md).

Exercise opt-in and platform-specific entrypoints with the same explicit ownership. A developer's PATH can hide an unowned executable lookup, and an undefined build-time digest can hide import-time Home access. Test isolated PATH/Home lookup and compiled constants without an active Runtime. Coverage failure summaries must retain the owning test file for unnamed setup/teardown failures so CI truncation does not discard their identity.

Linux OS-sandbox probes that replace `/tmp` need an explicit fixture Home outside that mount. Use a unique directory in the owning package's ignored `.artifacts`, close its Runtime before removal, and clean it on opening failure. Keep ordinary fixtures under the shared test root. Preserve positive command-start and host-baseline assertions so a hidden working directory cannot pass as a successful denial.

Full runtime fixtures that exercise model execution must serve both chat and embedding protocols when Library is enabled; a fresh home must not silently turn an execution test into a Hugging Face model-download test. Keep Library retrieval/encoding enabled and assert the normal execution evidence; validate real embedding assets separately.

Use a fake or local boundary only where the external system is not the subject of the test. Do not add Jest/Vitest mocks to the Bun suite without an established package-specific reason.

For MCP OAuth changes, use the real SDK and both HTTP and SSE transports against an isolated authorization server. Overlap rotating refresh requests, a newer login, logout and asynchronous cleanup; cover late successful and rejected exchanges, scope challenges, repeated callbacks and cancellation of one shared-auth waiter. Hold tool replies behind a barrier to verify that coordinating authentication preserves ordinary request concurrency.

Installed-package acceptance shares the isolated environment returned by `withInstalledPackages` with every spawned consumer. Isolate both HOME and XDG configuration: Bun can read user `.npmrc` from `XDG_CONFIG_HOME` even when HOME is replaced. Keep the fixture registry available to nested installation generations and test against a conflicting ambient registry without copying credentials into published artifacts.

Playwright DOM-test fixtures that boot a Vite dev server must declare their package prerequisites: published Plugin entries use the root coverage command’s dependency build; alias other workspace-package entries whose `import` condition points at gitignored `dist/` output to their source entry when the fixture tests source behavior; resolve runtime packages that break under dependency pre-bundling (Lingui's `@messageformat/parser` chain) to minimal fixture-local stubs when the suite asserts behavior unrelated to i18n rendering, or add them to `optimizeDeps.include` when the real runtime is the subject; set `optimizeDeps.include` for the Solid runtime/JSX runtime/zod with `noDiscovery: true` so the optimizer never re-runs mid-load and reloads the page; scope `cacheDir` to the fixture temp directory so sibling Playwright servers sharing `node_modules/.vite` cannot invalidate each other; `warmupRequest` the fixture entry before launching the browser and surface page/console/HTTP errors in the failure message instead of a bare 30s selector timeout; and register the suite in the package's `playwrightIsolated` list so bun's worker reaping cannot kill its Chromium process mid-suite. See the [hermetic Vite fixtures decision](../../../docs/decisions/implemented/testing/2026-08-31-hermetic-vite-fixtures-for-playwright-dom-tests.md). Root production-host UI acceptance follows the same process isolation: run `bun run plugin-ui:test`, which starts one Bun process per suite in sequence, instead of passing the entire browser directory to `bun test`.

For inbox-to-transcript transitions, exercise settlement while a real inbox item has been drained but its message is still being materialized, then again after materialization. Verify that the continuation and a task queued behind it both execute. Test persisted contradictory terminal state through the registered migration as well as fresh runtime ordering; a restart-only test cannot prove that durable state was repaired.

For attachment preparation, cross uploaded Asset and inline data inputs with Home, Project-without-Workspace and bound Workspace sessions. Set `Session.create({ workspace: null })` explicitly: a null ambient Workspace alone does not establish an unbound Project session. Assert model-visible text or image bytes, legacy text decoding, explicit model policies, retained media bytes, managed-path containment, and whole-input failure followed by healthy queued work. Exercise document extraction and vision children through a real Runtime and HTTP provider fixture; live acceptance additionally checks synthetic content through the configured model and terminal input status.

Recovery migrations must also exercise startup with no newly queued task, failed wake attempts, and repeated startup. Persisting repaired state alone does not prove that startup can discover and execute the work. When adding migration imports, run the fresh-process migration registration and owner-ledger tests; a suite with preloaded session modules can hide a cold-import cycle.

For startup maintenance, pair real SQLite lifecycle tests (opening DDL, VACUUM/checkpoints, verification and failed DDL) with a fake monotonic clock at the Desktop consumer. Cover overlapping operations, duplicate/stale events, phase changes during maintenance, completion returning to the underlying deadline, and failure/worker loss. Assert observers run in the caller context even after transaction retries. Exercise split stdout/stderr and reused log files through a real managed child, then validate indeterminate elapsed time and long error details in Electron. Never let small fixtures or pre-recorded progress alone certify producer-to-consumer coverage.

## Local Performance Experiments

For file-view acceptance, alternate public tools, history/undo, file services and actual formatter/LSP/plugin processes against the same bytes. Language fixtures must verify delivered text against their own filesystem; fixed diagnostic strings cannot establish target consistency. Hold a process callback at an observable barrier, edit old and new targets externally, switch the Session binding, and verify both physical files after the callback settles.

For startup-to-conversation acceptance, test fresh, historical and large homes through durable input admission, canonical publication and model completion on the same fixture. Include multi-turn recall, duplicate admission, retry after pause, terminal historical roots and repeated Runtime restarts. Record the fixture's node, record, owner and artifact distributions; a large unrelated namespace proves cleanup scaling but does not establish retention owner-enumeration capacity. Keep machine-dependent timing thresholds in local reports, with correctness and recovery invariants in CI.

Budget live model calls at the provider boundary before forwarding them, counting auxiliary tasks and retries as well as user turns. Preserve interrupted attempts and explicitly record configuration variants. A soak report must identify the source revision and process restart boundaries; source edits do not reload an already-running parent's modules.

Benchmark adapters must pass the environment's `agent_process_env` to the agent invocation so restricted-network tasks retain the evaluator's inference egress. Test both proxy-enabled and ordinary environments while keeping provider credentials in temporary private files. Validate streamed requests through the proxy and recording path: a direct provider probe, an internet-enabled task, or a successful proxy HEAD request does not establish that the actual model transport works.

Test process signals through an actual child process after a deterministic provider readiness barrier. An in-process abort or timer preserves different async context from an operating-system signal; both paths must retain Scope ownership and terminal accounting.

Use the [benchmark workspace](../../../benchmark/README.md) for model-backed task subsets and A/B evidence. Keep the evaluator, measured source, runtime recipe and dataset identities separate. Compare complete task-repeat pairs; preserve interrupted attempts and unknown accounting. Never substitute a static task-manifest check for an oracle/verifier execution result. Run the deterministic local-provider Docker test when changing preparation, the CLI bridge, cancellation, mounts or rollout capture. For stream/recording changes also run `SYNERGY_ROLLOUT_LONG_STREAM=1 bun test --cwd packages/harness test/session/rollout-long.test.ts`; independent CI workers own its completed, cancelled and failed outcomes, and the test aggregate requires all three. Keep each outcome in a separate process so a timed-out test body cannot overlap the next sample; retain the completed 30 MiB byte-integrity load with 32 KiB chunks; select `SYNERGY_ROLLOUT_CHECKPOINT_STRESS=1` explicitly for the historical 1 KiB checkpoint pressure and use smaller received payloads for cancellation and failure, preserving report persistence, archive verification, usage and fixture-cleanup progress. Size the test and outer job deadlines to include deletion of the retained evidence, with job time remaining for process cleanup. Apply the benchmark’s fixed three-hour budget to solving, reference execution and verification; preserve failed rewards and historical evidence. Inspect exporter exit/signal/deadline, archive validation, recording coverage, unknown usage and owned Docker residue independently. Test terminal-evidence reconciliation before allowing resume to schedule another paid attempt. Container-created mode-0600 accounting and mode-0700 ledger directories are not host-readable on Linux until Pier hands logs back. Test that boundary without widening permissions; inspect active evidence inside the verified owned container.

## Run Core Suites Through the Orchestrators

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

Select batched Web, UI and package suites with `SYNERGY_TEST_FILES` containing a JSON array of inventory paths; their package scripts do not consume positional file arguments. Run direct `bun test` from the owning package directory. When product labels change, update real-host accessibility locators while retaining the persistence and interaction assertions.

Run the narrow failing test during iteration, then the affected package/domain suite, then `quality:quick`. Run the full suite when the change crosses shared abstractions, persistence, generated contracts, package publication, or release boundaries, or when the user requests it.

`bun run test:ci` runs the complete core inventory in fresh sequential batches. `test:coverage` uses the same executor with instrumentation; CI executes that inventory once and requires JUnit, lcov and timing evidence for every selected batch. See [CI verification](../../../docs/operations/ci.md) for `ci:plan`, `ci:run`, `ci:verify`, affected selection and diagnostic selectors. Assign Harness, Web, Presets, UI and Local Runtime to 4, 4, 4, 2 and 2 measured file-weight partitions, preserving complete isolation batches and special isolated files; each process owns its Home, fixture root and database. Bind ports dynamically in fixtures; distinct runners provide host isolation.

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

CI workspace test concurrency must account for each package spawning native workers and browser/build processes. Run independent package suites serially on each shared runner because unconfined native write claims cross Runtime homes; preserve dedicated concurrency tests inside suites and parallelism between isolated runners. Retain the full suite graph. Failure diagnostics must reserve output space for both stream summaries; print failed coverage commands before the uncovered-line listing and retain bounded assertion differences across blank separators. Native watcher readiness probes must finish pending writes and observe their deletion before testing a neighboring file creation, so fixture events cannot be mistaken for a rename. Every new CI job must install its own executable and build prerequisites; runners do not share Chromium or workspace dist output. Separate suite execution from plan-bound threshold aggregation. Test that missing partitions, stale SHA/run/digest, repeated files, missing reports and failed jobs reject admission. Never credit an unselected or historical lcov report. Preserve required check names through a fan-in that rejects failed, cancelled and skipped dependencies.

For pause/abandon transitions, hold descendant cancellation behind a promise and release the real session lease before repair finishes. Assert that queued work is not scheduled, concurrent pause writers retain one reason, and the final status event and API response agree with canonical state after abandonment.

For composer hold gestures, exercise the native pointer-down, partial/full hold, pointer-up and click sequence. Cover release while the request disables the button (no native click), then a new pointer or keyboard activation after completion. Assert draft preservation and request counts, not only a timer callback. For paused input, capture the first resumed provider request and assert the original root plus the new user direction. Verify accepted-input run identity independently from the new message identity, including CLI polling and cancellation. Pair pause/resume tests with fresh input after terminal run cancellation; the old cancelled root must not reopen or block the new task.

When integrating new tests after Runtime ownership changes, adapt every newly introduced fixture and subprocess entrypoint, including migration fixtures that open storage before registration is sealed. Register execution contributions in the fixture composition; vary the contribution's test-controlled outcome instead of replacing sealed registrations. Storage-engine tests without a product Runtime must use deterministic engine defaults, while native callbacks for an owned engine retain its creator's configuration.

For file writes, exercise exact-byte conflicts after restoring the original mtime, approval-time changes, cancelled waiters, real concurrent processes, parent symlink replacement, hard links and BOM/line-ending preservation. A timestamp-only assertion cannot validate overwrite safety. Browser fixture servers use ephemeral ports and explicit startup budgets so unrelated local instances and dependency warmup do not determine the result.

For Workspace upgrades, migrate a directory while it is absent, create a different directory at the same path, and verify that native access still requires explicit rebinding. Re-registering the location must not silently authorize the old identity. After rebinding, test both stale generations and another physical directory replacement.

Workspace coordination tests must cover two Runtime instances, overlapping and disjoint physical roots, root expansion, cancellation during admission and capacity resumption, stale lease release, and a live native process surviving its logical task. Exercise real Session and Cortex paths with one execution slot and parallel tools: a waiting child must not monopolize capacity, and one waiting tool must not release capacity still used by its active sibling. Assert physical claims independently of tool or turn completion. Drive active Workspace changes through `SessionManager.run`, not a manually acquired loop lease: only the former owns the native task context. Cover concurrent operations, stale generations, persistence failure, lost old directories, process survival and unresolved child/fork references.

For multi-stage operations that reuse a cancellation signal, test a real `AbortSignal.timeout` across completed child processes, native lock admission and cleanup. Attaching and removing listeners between stages must not disable the caller's deadline; keep an operation-wide cancellation bridge when required by the supported runtime.

Platform-only native implementations must contribute coverage from their actual OS runner. The macOS and Windows Workspace tasks use `script/native-workspace-coverage.ts` to inject an isolated home before spawning Bun and produce fresh JUnit and LCOV reports. Capture both in the task result with its plan/SHA/run/attempt identity, normalize Windows paths, and keep the aggregate dependent on both platform jobs and the complete Local Runtime coverage baseline; do not lower package thresholds or classify executable native parents as unmeasurable.

Each package test command must prepare the native assets its own tests execute. A sibling package's build is not a prerequisite in an independent coverage shard. For native launch failures, verify that a subsequent real writer is admitted after missing assets or cancellation before supervisor ownership; checking only the launch error cannot detect a leaked lease.

For snapshot capture, verify exact bytes under text, ident and encoding attributes, same-size changes with restored timestamps, nested/global ignore precedence, file/directory transitions and literal symlinks. Exercise deep Workspace, object-store, index and transfer paths together on Windows; a successful Git initialization alone does not cover native reads or retained object access.

For native file previews, mutate size after metadata resolution and verify bounded failure, then read through an internal symbolic link whose target is longer than the link text. On Windows, copy file links, dangling directory links and junctions without changing their native type; compare preserved mode bits to the filesystem's actual mode rather than a POSIX-only fixture value.

For worktree cancellation, exercise an activated checkout hook and a native command on each supported OS. Verify full process drainage before admitting another writer, rollback of the owned unpublished directory, and retention after foreign lock replacement or a new commit. Pre-cancelled calls alone do not cover post-activation cancellation.

Native integration suites on the same host share write coordination even when fixture directories differ: unconfined processes can block an unrelated exclusive rebind. Retry only the expected busy result within a finite test budget when contention is incidental. Assert LSP connected status during an active query, and validate protocol replies plus native exit before a competing write; the caller promise may settle later while its use claims drain. Run repetitions in fresh Bun processes because the preload disposes its fixture root after a run.

For deferred work that captures Workspace identity, test origin selection changes, an explicit no-directory selection, persistent execution selection, missing or imported bindings, and the owning upgrade. Native file-watch tests must start without an open Session, survive rebinding and restart, and reject events from another Scope, Workspace or generation. Global item storage is separate from its file-event owner.

Cross-process filesystem coordination must remain shared when the processes have different temporary-directory environments. Exercise a held native claim with distinct `TMPDIR`, `TMP` and `TEMP`, verify exclusion, then verify admission after release; different fixture Homes alone cannot establish this property.

For large in-memory stream/archive loops, measure the first subsequent I/O as well as the loop itself. Bound work between event-loop turns; deferred runtime cleanup can otherwise be misattributed to storage or fixture removal. Keep byte-integrity and responsiveness regressions alongside the owning archive tests.

Build reuse must cover the transitive workspace inputs and outputs of the recipe, including build-time dependencies. Shared Solid/Vite DOM fixtures compile once per UI runner, verify input/output digests and retain separate test processes and DOMs. Wait for lazy content to render rather than assuming one timer tick completes an import. Compile the committed SDK with `--compile-only` during CI preparation; regenerating source while preparing a cache breaks its input identity. Keep native tests that require prepared outputs out of the pure contract task inventory.

For benchmark artifact consumers, derive executor routing from task dependencies and verify every generated matrix consumer downloads and unpacks its producer artifact before execution; do not duplicate task-name lists in workflow step conditions.

When splitting expensive controls across CI tasks, verify the generated execution units and the real test runner's collection for every selector. Keep each selected scenario exactly once and reject skipped, missing, failed or duplicate JUnit results. Retain a bounded real compaction-and-continuation workflow with disk, export and usage assertions; keep historical 120-round JIT/protocol pressure opt-in for diagnosis. Four short semantic combinations retain model/protocol/JIT coverage. Separate pressure from short semantic dimensions only when representative combinations preserve the actual design goals; prove tool, disk, usage and runtime behavior with counterexamples rather than source-text assertions. Independent controls must not consume each other's completion budget.

For installed core/full controls, build each profile once in its own producer recipe and trace every consumer to that recipe's outputs. Bind distribution reuse to the original plan, commit, run and plan attempt, then verify ABI, complete inventory, bytes and modes before restoring. On same-SHA failed-job reruns, identify the actual latest producer attempt from GitHub; reject failed or expired producers. A new SHA needs a fresh plan and verification. Preserve installed file modes in shared fixtures and verify unchanged inventory and bytes after use; recursive read-only chmod also changes the modes of runtime copies in fresh Homes. Prove full composition with no preceding core distribution or installed Home; preserve fresh tarball installs, component and upgrade coverage, and exact input byte/hash checks. Compare identical tested source trees and per-command progress before attributing a cancelled job to a runtime deadlock or increasing a deadline.

Expensive integration selection must trace base and head inputs, including cross-workspace production and test resources. Unknown aliases or dynamic inputs conservatively select the task for code changes; an incomplete graph cannot prove that another package is irrelevant. Keep ordinary selected package suites complete. PostgreSQL-only CI must select the explicit backend, retain every required version and reject a missing database URL; lightweight storage fixtures must still exercise real engines and cleanup.

Register new opt-in PostgreSQL controls in the shared backend inventory and verify their generated commands for every supported database version. A green PostgreSQL job does not cover an unregistered test; assert the control's input registration, executable test argument and required database environment together.

Compute cross-run cache keys on the producer with its actual compiler and runner image. Validate cross-job reuse against source and runtime ABI compatibility; hosted image rollouts can assign different image versions within one workflow. Exercise that transfer while retaining byte, mode and inventory rejection tests.

Declare executable prerequisites on catalog tasks and derive browser-suite setup from workspace Playwright dependencies. Test a browser package selected alone, since another task in a full batch can hide a missing installation. Stage verified source sandbox helpers at the canonical Cargo output path so each isolated Runtime can discover and install them into its own Home; retain the ephemeral runner's standard helper installation for installed-helper end-to-end probes. Route every package coverage entry through the shared executor and verify that it produces JUnit, lcov and complete batch timing inventories, not only a successful test exit code. Preserve previously unbatched suites with `SYNERGY_BATCH_SHARDS=1`; compare measured coverage before changing process groupings, since Bun's merged reports are not fully equivalent to one process.

Workbench visual regressions require the real composed page in addition to focused geometry fixtures. Do not replace status, input ownership or menus with empty renderers in final acceptance. Verify both new-task and existing-session paths, including modal focus restoration after a task starter replaces text. Compare visible bounds before/after hover and popup opening, and exercise short windows and narrow panes independently of browser width.

For sidebar/titlebar changes, require actual registered-Shell acceptance in addition to focused chrome fixtures. Cover windowed/fullscreen × expanded/collapsed, zero closed navigation occupancy, cross-page restore, preserved sidebar scroll and editor identity, inert hidden controls and no descendant painting. Check native overlay geometry after fullscreen reload and zoom; CSS-inset simulations establish layout behavior only. Model popup regressions need empty, short and long result sets with a reachable footer, while Add-menu checks preserve real sections, guards and keyboard navigation. Run Chromium-backed suites serially when process cleanup could reap sibling browsers.

Same-SHA partial CI reruns must keep the original plan and namespace reports by execution unit and attempt. Admit exactly one result for each task from the latest actual GitHub unit execution, with the same SHA, run and plan digest; an older success cannot replace a newer failed, cancelled or missing execution. GitHub copies untouched completed jobs with new attempt numbers; exclude a copy only when both execution timestamps precede its record creation. Missing timestamps cannot justify falling back to older success. Apply the same rule to producer selection and compute accounting, and verify it with a real installed-consumer rerun. Reject duplicate receipts, altered report bytes and expired inputs; expiration requires rerunning all jobs. Merge JUnit and lcov only from admitted results.

Spawn-based fixture environments omit `GH_TOKEN`, `GITHUB_TOKEN` and the parent `SYNERGY_TEST_FILES`; the owning runner consumes its selection before spawning batches. A credential behavior fixture supplies its own token explicitly. CI orchestration retains read-only job metadata access outside product test children. Build-artifact fixtures explicitly select their Web preparation mode and restore inherited CI settings after each case. Docker CI groups may run two tasks with separate Homes, processes, containers and report paths; Windows jobs remain serial while isolated native file batches may overlap.

Split independent installed component and Web lifecycle controls into fresh Homes. Within a sequential full outcome group, reuse the installed Home while isolating each workspace, provider and Session; verify daemon/owned-process closure before the next case and installation bytes after the group. Separate ordinary, core and full consumers so runners are acquired after only the required producer completes; keep queue budgets inclusive of profile consumers and contracts. Cold build acceptance must disable Rust target and verified output caches while allowing dependency downloads. Wait for published terminal evidence with a bounded deadline instead of assuming a native close finishes within a fixed short sleep.

For CI throughput, assign one package partition per runner and overlap at most two independent task processes, each with its own Home and reports. Keep the contracts cluster and local diagnostics sequential. Restore a shared distribution once before its consumers overlap, and settle every worker before publishing failures. Windows jobs remain serial; the native file batches may use two isolated processes under that one job, with separate JUnit/lcov directories and a checked complete inventory. Measure cache restore time as well as installation: skip a Windows download archive when unpacking it costs more than a fresh scoped install. Build Web once alongside native preparation, validate its complete bundle before distribution reuse, hash contained source file links by both target path and bytes against the canonical repository root, keep output links forbidden, and keep normal release builders responsible for their own Web build.

CI planning installs only its testing workspace dependency closure and resolves the TypeScript parser from that workspace. Validate scoped installation outside a parent checkout so ancestor dependencies cannot mask missing imports. Budget executor pools with producer and consumer queues together; use completed task reports for weights and keep critical consumers below the shared organization slot limit. Current Linux queues are ordinary 6, core 1, full 4 and contracts 1, each ordinary/profile worker overlapping at most two isolated tasks.
