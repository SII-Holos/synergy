## Review: install lifecycle delivery, state visibility, retry, and boot behavior

Reviewing the `lifecycle.install` / `runtime.started` / install catch-up implementation. This comment covers four design issues plus code issues. A fix branch with tests is prepared (see summary at the end).

### 1. Install lifecycle failure is silent, unobservable, and not retryable

- `synergy plugin add` calls `Plugin.add()` in a standalone CLI process where `Server.listen()` / `configureRuntimeEndpoint()` never run. Any install handler touching `context.runtimeEndpoint.get()` would always throw `PLUGIN_RUNTIME_ENDPOINT_UNAVAILABLE` there, and `peekRuntimeEndpointGeneration()` is always `undefined` so the `runtime.started` catch-up never fires.
- `add()` ignored the result of `runPluginInstallLifecycle()`: failures only landed in `markContributionDegraded()` plus a warn log. Both the CLI and the Web UI reported the install as successful.
- There was no retry surface anywhere. The docs said "the plugin should expose an explicit retry", but the host provided none — a degraded contribution could only be uninstalled and reinstalled (which may fail again).

### 2. `freshInstall` was decided from a pre-transaction snapshot

`freshInstall = !oldPlugin && !before?.disabled.some(...)` read loader state before the install transaction commits. If the plugin spec was already present in config but in a disabled/approval state, a genuinely fresh install was misclassified as non-fresh and both `lifecycle.install` and the `runtime.started` catch-up were skipped. Conversely, a previously completed install that was disabled and re-added would be re-run.

### 3. Boot behavior

- The `runtime.started` broadcast forces `ensureRuntime()` (process spawn) for every plugin declaring the hook, serially, with the observer timeout each; a crashing plugin is re-spawned on every boot. (Kept as designed — failures degrade only the contribution and do not block startup.)
- `registerShutdown()` called `configureRuntimeEndpoint(undefined)` at the start of graceful shutdown while plugins were still draining — `runtime.endpoint.get` returned `UNAVAILABLE` during drain.
- A pending/failed install state was not persisted anywhere, so a plugin installed via CLI never got its install lifecycle delivered, and there was no way to retry a failed install.

### 4. Other code issues

- `context-factory.ts` exposed `runtimeEndpoint` from the plugin-level capability only, unlike `agent.call` which is additionally filtered per-contribution via `contribution.requires` in `contextFor()`. A contribution without `requires: ["runtime.endpoint.read"]` received a non-undefined service that then threw at call time — inconsistent with the `agent.call` precedent.
- `SettingsSectionContent` used `section().context!` and cast built-in components to `Component<PluginSettingsComponentProps>` even though built-in sections carry no context; the shared render path type-lied about two different contracts.
- `peekRuntimeEndpoint()` was exported but unused (dead code).
- Desktop `serverCommandArgs` now always binds `127.0.0.1` on all platforms — a platform behavior change bundled into this PR without being called out (left as-is; the health check already hardcodes 127.0.0.1).

### Fix summary (local branch `fix/pr-1052-review`, five commits, tested)

- **Persisted install-lifecycle state**: `lifecycleInstall: "pending" | "completed" | "failed"` on the lockfile entry (optional, backward compatible). Inside a host process the handler runs immediately after the transaction commits and the outcome is persisted; outside a host process (`synergy plugin add` in a standalone CLI) the entry stays `pending` and is delivered at next host boot (`runPendingInstallLifecycles` in `server/runtime.ts`, before the `runtime.started` broadcast) or at the next plugin runtime reload (`runtime/reload.ts` plugin case, which additionally delivers the `runtime.started` catch-up since there is no broadcast on that path). Fresh installs **without** a `lifecycle.install` contribution never write the field, so `retry-install` reports "no contribution" and catch-up never reprocesses them; stale `pending` entries written by earlier versions converge to `completed` on the next delivery.
- **Observable outcome**: `LoadedPlugin.installLifecycle` carries the result; `synergy plugin add` prints queued/failed/completed feedback and suggests `retry-install` on failure.
- **Retry**: new `synergy plugin retry-install <id>` re-queues a failed or pending install. A completed install is never re-run; a loaded/caller-supplied plugin whose generation does not match the lockfile entry fails loudly with a coded `PluginInstallLifecycleGenerationMismatchError` (reinstall or update to retry). Retry is lockfile-driven, so it works even when the plugin runtime is not loaded (crashed/disabled). Failed installs are never retried automatically.
- **freshInstall**: now `oldPlugin === undefined && lockfile lifecycleInstall !== "completed"` — disabled/approval-pending entries cannot suppress `lifecycle.install`, and a previously completed install that was disabled and re-added does not re-run it. Fresh installs without a `lifecycle.install` contribution still receive the `runtime.started` catch-up.
- **Capability symmetry**: shared `contributionGatedCapabilities()` helper gates `agent.call` and `runtime.endpoint.read` per contribution `requires` in both the process runner and the in-process manager.
- **Shutdown**: runtime endpoint cleared in a `finally` after `server.stop()` so drain-time reads keep working and a failed `server.stop()` cannot leak the endpoint.
- **Lockfile safety**: `Lockfile.write` uses unique temp names (pid + timestamp + uuid); `persistInstallLifecycle` runs under the installation lock; persist failures are logged, never thrown out of `add()`.
- **SettingsPanel**: host-side optional-context props type; built-in panels receive no `context`; the public plugin contract is unchanged.
- **Dead code**: removed unused `peekRuntimeEndpoint()`.
- **Docs**: `runtime-and-permissions.md` and `cli.md` updated for the state machine, `retry-install`, and the generation-mismatch error.

Tests: `install-lifecycle.test.ts` (14 tests, including an `add()`-level test proving fresh no-contribution installs commit without the field and a stale-pending convergence test exercised through `runPendingInstallLifecycles`), `runtime-endpoint-filter.test.ts` (per-contribution gating). Full plugin + plugin-runtime suites: 206 pass / 0 fail; oxlint and prettier clean.
