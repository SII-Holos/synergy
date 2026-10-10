---
name: develop-synergy
description: Run and test a source checkout of Synergy in an isolated second runtime without stopping or modifying the active Synergy instance. Use for source development, end-to-end verification, alternate branches/worktrees, bun dev web or desktop, managed Desktop testing, port conflicts, and SYNERGY_HOME isolation.
---

# Develop Synergy Safely

## Protect the Active Runtime

Never stop, restart, signal, or reuse the `SYNERGY_HOME` of the Synergy instance carrying the current task. Do not run `synergy stop`, broad `kill`/`pkill`, or modify its data/lock files.

For startup or migration changes, seed an isolated installed database with cold Sessions and operations before timing readiness. Run `bun test test/lifecycle/history-startup.test.ts` from Harness, then the affected page/recovery tests. Report Core preparation separately from HTTP/UI readiness and actual bytes read separately from logical dataset size; never use the live Home as a performance fixture.

Read [Development reference](../../../docs/reference/development.md) before choosing a mode.

## Prepare an Isolated Home

1. Choose a dedicated parent directory and explicit free ports. Check listeners with `lsof -nP -iTCP -sTCP:LISTEN` or the platform equivalent; do not assume `4097` and `3001` are free.
2. Create the required `.synergy` parent:

```bash
DEV_HOME=/tmp/synergy-dev-<short-name>
mkdir -p "$DEV_HOME/.synergy"
```

3. Start with minimal fixture configuration. Select only the provider configuration and credential needed for an explicit real-provider check; never copy the entire live configuration or credential store implicitly. Do not copy sessions, daemon state, locks, logs, cache, or Library data — the two model catalog files in step 4 are the sole cache exception. Seed only the fixture credentials a test requires inside the isolated home; never copy or overwrite the live credential store implicitly.
4. Copy model catalog data from the main home when the isolated environment cannot reach models.dev (offline or restricted-network debugging machines), so the isolated model list does not depend on a live models.dev fetch:

```bash
mkdir -p "$DEV_HOME/.synergy/cache"
for f in provider-model-catalogs.v1.json models.json; do cp ~/.synergy/cache/"$f" "$DEV_HOME/.synergy/cache/" 2>/dev/null || true; done
```

Treat these two cache files as seed data only: they are refreshed in place by the isolated runtime and never copied back to the main home. If the files are absent from the main home, the isolated instance will fetch models.dev on first use as usual.

5. Run `bun dev prepare` once when dependencies, generated SDK, Web dist, plugin SDK, or sandbox helper are missing. Linux preparation also builds the pinned Parcel watcher binding with its EINTR fix through `packages/local-runtime/script/build-watcher.ts`; Docker provides the target compiler image. For native watcher changes, run `bun test --config /dev/null test/script/watcher-native.test.ts` on glibc Linux after rebuilding. Exercise real recursive ignore rules, ONNX loading in both orders in fresh Bun processes, and signal recovery; Node-only or empty-ignore smoke tests miss C++ runtime collisions. See the [watcher build reference](../../../packages/local-runtime/script/watcher/README.md) for target dependencies.

## Choose the Smallest Mode

```bash
SYNERGY_HOME="$DEV_HOME" bun dev server --port 4097
SYNERGY_HOME="$DEV_HOME" bun dev app --attach http://127.0.0.1:4097 --port 3001
SYNERGY_HOME="$DEV_HOME" bun dev web --server-port 4097 --app-port 3001
SYNERGY_HOME="$DEV_HOME" bun dev desktop --server-port 4097 --app-port 3001
SYNERGY_HOME="$DEV_HOME" bun dev desktop --managed --server-port 4097 --app-port 3001
SYNERGY_HOME="$DEV_HOME" bun dev send "test request"
```

Development modes bind to loopback by default. To expose an isolated Web stack deliberately, bind both the source server and Vite app with the shared hostname flag:

```bash
SYNERGY_HOME="$DEV_HOME" bun dev web --hostname 0.0.0.0 --server-port 4097 --app-port 3001
```

Use `server` for backend/CLI work, `web` for normal full-stack work, `desktop` for Electron-native behavior, and `desktop --managed` for the production-style managed-server path. Managed mode rebuilds the Web distribution before launch.

Parallel source Web processes in the same checkout share Vite's dependency cache unless it is explicitly isolated. For an additional frontend inspection process, use Vite's `createServer` with a task-owned `cacheDir` outside the checkout, the App directory as the process working directory, and explicit server URL and port. Keep the separate Home as well. Do not clear a shared cache or restart another instance to resolve an `Outdated Optimize Dep` response.

Development process lifecycle is owned by the root orchestrator. Both serial build-and-run workflows and parallel workflows tag their descendants at spawn time so cleanup can recover nested process groups even after package wrappers exit. A managed Desktop server arms parent-process liveness monitoring before startup becomes healthy and shuts down if its Electron parent disappears, because forced application termination cannot run Electron quit handlers.

Managed Desktop captures the user's login-shell `PATH` once and passes only its normalized value to the managed server, preserving inherited absolute entries as fallbacks. It does not import arbitrary profile variables. Verify the effective value and fixed command resolutions in developer-mode Settings → Observability; a Desktop-process source indicates that the login-shell probe safely fell back. Do not replace this startup boundary by making Bash tool execution use a login shell: Bash remains ordinary `shell -c` under the sandbox environment allowlist.

## Reproducible Workbench Acceptance

With the isolated server and App running, seed synthetic projects and tasks through the generated SDK. The local provider replaces only inference; the real server, submission, synchronization and UI still run.

```bash
bun apps/web/test/fixtures/workbench/provider.ts "$DEV_HOME" http://127.0.0.1:4097 4098
bun apps/web/test/fixtures/workbench/seed.ts "$DEV_HOME" http://127.0.0.1:4097
bun run --cwd apps/desktop build
bun apps/desktop/test/fixture/isolated-desktop.ts "$DEV_HOME" http://127.0.0.1:3001
```

Choose free ports first. Both Web fixtures validate the server's actual Home before mutation; seeding refuses an existing manifest. The provider records chat, auxiliary and embedding calls separately at `/journal`, and `[long]` selects a delayed long response. Keep the manifest and logs private. The Desktop helper sets isolated Electron `userData` before importing main and acquiring the single-instance lock, writes its child PID/log under the selected Home, and forwards termination only to that child. Reuse that Home for restart/persistence checks. A real-provider check and native IME check remain separate evidence.

For final acceptance, build Web and point Desktop at the isolated server's production Web origin. Record source revision, lockfile hash, viewport/zoom/theme, fixture manifest and observed result. Exercise the same built origin in Web and Desktop, including real status details on new tasks, project context, task starters, draft/attachment preservation, native chrome and split-pane menus. Save light/dark screenshots and a short hover/menu/split recording; isolated component tests do not establish whole-page visual acceptance. Stop only the helper/server/provider processes whose PID and Home were recorded, then verify their ports are free.

## Preserve Desktop Renderer Lifecycle

Route main-process broadcasts for the application renderer through `DesktopRendererDelivery`. A live `BrowserWindow` or `WebContents` does not prove that its current main frame can receive IPC during startup, document navigation, reload, renderer exit, or shutdown.

- Restore delivery only from the trusted `desktop.startup.appReady` handshake; let main-frame navigation, renderer exit, and destruction invalidate it.
- Use `sendLatest()` for replaceable snapshots such as window, theme, and update state; use `enqueue()` for one-shot messages such as deep links; use `send()` for transient events that should be dropped while the renderer is unavailable.
- Keep startup-overlay updates on the overlay's own `WebContentsView`; it is not the application renderer.
- Cover pre-ready, main-frame reload, post-ready convergence, destroyed/detached frame, and renderer-exit behavior before running an isolated Desktop cold-start and reload check.
- Use Electron Window Controls Overlay geometry for native control exclusion; fullscreen clears the inset. Verify ordinary/fullscreen × expanded/collapsed, then repeat with a side workspace, after reload and at 200% zoom. Do not infer fullscreen from dimensions or replace the geometry with fixed offsets.
- Keep renderer window-state broadcasts disabled on macOS. Native fullscreen moves the window across Spaces asynchronously and can emit unstable focus/fullscreen transitions; macOS uses native chrome and should query state explicitly when needed.

## Verify and Diagnose

Load [testing-guide](../testing-guide/SKILL.md#review-test-value-and-ci-cost) before changing automated verification. Review affected existing tests together with new coverage, and include consolidation or removal when behavior is obsolete or duplicated. Select the smallest relevant check locally; use the [CI cost policy](../../../docs/operations/ci.md#维护验证成本) for measured changes to expensive preparation or full workflows.

1. Confirm health on the selected server port before opening dependent clients. After workspace or startup entry changes, run `bun test --config /dev/null test/script/dev-entrypoints.test.ts` against the real checkout, start the root development command in an isolated home, and verify Web rendering in a browser. For managed Desktop changes, verify source backend startup, restart and shutdown separately from packaged startup; serving HTML alone does not establish that the UI rendered.
2. Reproduce the behavior with a new isolated Scope/session. Record only redacted IDs and project-relative evidence in shareable output.
3. Use `SYNERGY_HOME="$DEV_HOME" synergy logs --dev`, `status --verbose`, or `diagnostics` against the isolated environment. Never inspect the main runtime by accident.
4. Restart only the isolated process when server or Desktop main-process code changes; Vite handles Web hot reload.
5. Start with `bun run verify plan`, iterate with narrow behavior tests, then run `bun run verify local --test <repository-relative-test>` once before publication. Finish browser/build acceptance before static gates to avoid artifact mutation races. Tooling-only changes do not require a product runtime. Complete matrix and package-threshold admission remain CI responsibilities. Workflow path changes also require checking the referenced executable files and supported dry-run commands; YAML validation alone cannot prove that a command exists. Keep local helper preparation inside the selected isolated home.

For managed startup changes, test a fresh home and an isolated upgrade lasting longer than the ordinary health deadline. Include the real storage bootstrap before the central domain migrations, and activation after them. Verify scan progress before backup begins, throttled aggregate emission, repeated stage counts, failed imports without completion and the final health deadline. Verify advancing migration counts renew the wait, a second scan with smaller counts also renews it through a new phase, duplicate counts and ordinary logs do not, stalled work fails with its last progress, and only whole-Runtime readiness restores the health deadline. Run `SYNERGY_DESKTOP_RUNTIME_TEST=1 bun test test/startup-progress-runtime.test.ts` from `apps/desktop` to check the actual progress DOM in Electron. Keep startup progress aggregate-only and report it before awaiting long migration work. For maintenance without item-level progress, use the shared driver lifecycle throughout bootstrap, migrations and injected stores. Exercise a controlled maintenance interval beyond five minutes, then completion and restart; distinguish injected delay from measured engine performance. Verify operation/stage/elapsed time in Electron, fixed deadlines despite repeated announcements, and a visible failure reason above a scrollable current-launch tail. The legacy `validate-engine` decoder only supports older binaries; do not emit it from new code. Cancel background Git and copy work before releasing its owner slot, and measure an already-active restart without repeating sealed backup inventories.

Also exercise execution-history admission with a populated journal fixture. Startup registers trusted pending coverage or a deferred recovery epoch without enumerating historical owners or replaying their journals. Test that one damaged cold owner cannot block HTTP readiness or new work, while selecting that owner still verifies its evidence and fails closed. Recovery of the selected owner must finish before its first write, coalesce concurrent callers, remain retryable after cancellation, and never repeat external effects. Shutdown settles only writers touched by this Runtime. Report actual owner-local recovery work separately from startup; a fresh-home smoke alone cannot establish that an existing home starts successfully.

Trace every awaited storage operation between the migration summary and Runtime readiness, including interrupted imports, registered resource owners, quarantine state and notification reconciliation. Classify required global work separately from owner preparation and explicit maintenance; never move a history-wide scan into a differently named startup hook. For required global recovery, connect the real Runtime, CLI reporters and Desktop consumer in regression tests; hold each boundary beyond the ordinary deadline and exercise multiple committed batches beyond the inactivity budget, failure and retry. Announce the stage before its first await and count actual work, including retry work outside SQL callbacks. Do not treat the migration summary or a small already-migrated fixture as evidence that storage recovery has finished. Hold extension, resident and finalization hooks past the ordinary deadline, including multiple uninstrumented component hooks whose combined work exceeds the inactivity budget. Runtime lifecycle reporting must encompass all awaited startup work; component composition reports actual hook completions automatically. Verify HTTP success before the last hook finishes cannot admit Desktop, failed or cancelled late hooks never report readiness, and retry releases prior resources. Repeated lifecycle stages and late subsystem reports cannot hide a stall.

For startup presentation, verify known totals, advancing unknown-total counts, maintenance without item counts and a silent interval in the real Electron page. Step and total clocks keep running while the last-progress age increases; none may renew the backend wait or claim new work. Total discovery must preserve checked counts, retries must preserve the total clock, and duplicate or regressive maintenance stages must not reset activity. Pause indeterminate motion after a silent interval and resume it only on accepted progress. Check typed task labels without migration IDs or descriptions, legacy records without labels, light/dark skins including live changes, narrow/short windows, 200% zoom and reduced motion. Exercise custom window controls with real keyboard input, visible focus and live native state before the application renderer is ready; delayed initial replies must not undo newer state. Keep task announcements stable during count-only updates, and verify the live title's heading semantics in the actual accessibility tree. Remove obsolete source-style assertions when rendered behavior replaces them.

Include portable archive hashing/import and a retried database verification in storage startup tests. Progress observers must run outside retryable SQL callbacks; count actual repeated work monotonically and keep queued progress bounded. Version flags and built-in maintenance commands must remain available when plugin metadata cannot open storage.

Measure an already-activated restart separately from the first upgrade. Legacy-writer checks must preserve authority detection without requiring access to unrelated artifact trees or repeating full backup inventories.

For a recurring history-dependent startup failure, distinguish supervisor timeout from a child exiting on its own error. If the user authorizes real-data reproduction, use a consistent isolated snapshot, exclude credentials, rebind copy-local path ownership, and prevent writes, signals or network access to the original environment. Exercise the reported managed entry point and a restart. Keep snapshots and logs private; compare source fingerprints afterward. A warm copy passing below a suspected deadline is inconclusive: cross that boundary during actual nested storage work and report controlled-delay results separately from unmodified startup. Do not claim complete acceptance from progress rendering or health alone; observe Runtime and application readiness.

For CLI migration progress, exercise both foreground server and local `send --format json` startup. Keep human progress on stderr, display the step before its first await, and preserve stdout for command results or machine protocols. Test TTY updates, redirected output, `NO_COLOR`, `TERM=dumb`, failure cleanup and retry; explicit silent migration callers remain silent. Exercise ACP initialization on fresh and already-migrated homes with the Desktop progress environment flag both unset and inherited; its first stdout line must remain an ACP JSON frame and stderr must contain no migration rendering. Keep Desktop reporter selection in the server command rather than shared network resolution.

## Clean Up

Terminate only PIDs launched for this isolated home. Verify the PID/port before signaling it. Remove the isolated directory only after its processes have exited and only when no evidence is needed.

## Handoff

Report the isolated home label without exposing secrets, chosen mode and ports, reproduction steps, observed result, logs/trace filters used, automated checks, and whether cleanup completed.

## Native Computer Verification

For macOS Computer changes, load [change-computer-runtime](../change-computer-runtime/SKILL.md) for native and real-model fixtures, packaged candidate acceptance and visual checks. Use an isolated Desktop user-data directory as well as `SYNERGY_HOME`. The full `bun dev desktop` orchestrator registers the Computer host; `--attach` alone does not. `SYNERGY_COMPUTER_DRIVER_PATH` may select a verified development binary; candidate acceptance must use its bundled worker. Never replace a missing OS grant with another application's authority.

For OS permission verification, launch the isolated app through macOS LaunchServices and inspect its actual permission state. A terminal-spawned Electron can inherit the terminal host's TCC responsibility, so a successful preflight does not establish that the standalone Desktop app has its own grants. Use a clearly named isolated app bundle; never modify another app's identity or reuse its grants to make a test pass.

For Desktop maintenance recovery, test the same bundled CLI with an isolated old-format database, active-work refusal, duplicate clicks, cancellation, quit during launch, and startup diagnostics against unreadable storage. Run `SYNERGY_DESKTOP_LONG_MAINTENANCE_TEST=1 bun test test/server-maintenance.test.ts` in `apps/desktop` for a controlled interval beyond five minutes; this validates waiting behavior, not engine throughput. Verify real Electron recovery controls, unknown-total progress, external-server instructions and a retry after failure. Never infer migration success from a heartbeat or increase the ordinary startup timeout to cover optional work.

Native PTY changes require `bun packages/local-runtime/script/build-pty.ts` before isolated source tests. Verify complete output before exit, backpressure with a paused producer, Unicode split across chunks, client disconnection and detached descendants. The core/full runtime asset builder and workspace-module packer must carry the same library and license notices; acceptance outside the checkout must exercise the terminal as well as ordinary Bash.

Linux native process supervision requires pidfd syscalls. Verify them on the actual architecture; an emulated container may omit them even when its reported kernel version is recent. Detect unsupported supervision before activating user commands. Forced supervisor loss without a kernel completion proof must retain uncertainty, while ordinary Runtime loss drains and releases owned processes.

Keep a native operation's result and errno in the same native call. Capture errors in the packaged Rust library before returning through FFI; a later JavaScript read of thread-local errno can observe unrelated runtime work. Rebuild with `build-pty.ts`, exercise `test/process/owned-process-linux.test.ts` on actual Linux, and verify the library resolves in source and installed workers. Fault injection must retain real kernel operations, run in an isolated child process, and bound waits so owned children are cleaned up before the test runner's hard timeout. Distinguish a deterministic boundary regression from evidence about an intermittent failure's exact timing.

Build and load native assets with the same libc selector. Cover source glibc/musl detection, compiled overrides, non-Linux defaults and explicit cross-build targets through `test/process/native-library.test.ts`. Temporary asset selection tests can replace system inputs; they do not establish actual musl compilation or execution.

For modular release changes, verify a packed core and Web selection outside the checkout, then validate the whole release and Desktop inventories. Runtime resources belong to their package; update the shared release layout and installer upgrade/removal contracts together. Preserve checksum validation for filenames containing spaces and reject unlisted module files.

For frontend navigation acceptance, build Web and Desktop from the same checkout, run `bun apps/web/test/fixtures/workbench/verify-navigation.ts "$DEV_HOME" "$APP_ORIGIN"`, and run `bun apps/web/test/fixtures/workbench/verify-native-chrome.ts "$DEV_HOME" "$APP_ORIGIN"` on macOS after closing only that isolated Desktop. The native verifier runs Playwright's Electron inspector through Node, uses the isolated userData wrapper and production server, and selects the application URL rather than the temporary startup overlay. It exercises actual fullscreen/minimize/restore, waits for native transition completion and writes local screenshots and video. At non-default Electron zoom, use native capture and DOM geometry together. Follow with direct native drag/Spaces inspection; record automation limits separately instead of treating a dispatched command as proof. Never substitute synthetic CSS values for the final native check or report simulated input as native IME evidence.

Project-entry acceptance includes the same built Web bundle in managed Desktop and Web, plus external Desktop. Confirm that only a running managed Desktop connection to its own server opens the OS folder dialog; Web localhost and external Desktop localhost must open the service directory browser. Verify native Cancel, return focus and retained unsaved project fields. Capture computer/project selection and draft merge, main-folder/Worktree choices, project settings and folder errors/paging/multi-selection. Merely opening these surfaces must not allocate an Environment; compare resource state before and after preview, then verify first-send binding.

Use disposable real directories for project-flow acceptance, including two Git roots and a plain folder. Record the main-folder transition and verify Worktree source metadata before and after changing main. Preserve source fixtures and evidence until handoff. When native automation is unavailable (for example, a locked screen), continue Web and Desktop renderer checks but report OS-level picker, drag and Spaces coverage separately; an IPC call or renderer click is not native hit-test evidence.

## Isolate native Browser acceptance

Electron userData owns persistent browser partitions and is separate from the backend home. For an isolated source acceptance run, build Desktop and launch a task-owned `.mjs` entry which imports `{ app }` from the workspace Electron package, calls `app.setPath("userData", isolatedDirectory)`, then dynamically imports the absolute `apps/desktop/dist/main.js` path. Set `SYNERGY_HOME` to the isolated home, use the dev channel and explicit alternate server/Web ports, and connect only that local broker. Keep the entry and any registration secret outside the repository. Do not reuse the user's real Electron profile or copy browser credentials.

Launch the actual executable named by Electron's `path.txt` when recording the owned PID; killing a Node package shim may leave Electron running. Check the command line and port before stopping it. For CDP-based UI acceptance, connect Node Playwright to an explicitly enabled local debugging port and disconnect the client after each check; do not change the installed product's debugging settings. Rebuild and restart only the isolated main process after native changes. Use the same isolated userData across a controlled restart when testing login persistence.

When checking first-message recovery, inject a rejected send followed by an unavailable receipt and then a definitive missing receipt. Verify that waiting ends, the draft remains recoverable, and manual retry uses the same message identity exactly once. Check accepted-but-lost responses separately; unavailable status must never authorize automatic resubmission.
