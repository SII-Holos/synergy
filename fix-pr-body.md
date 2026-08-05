## Summary

Review-fix commits for #1052 (`feat(plugin): add generic runtime lifecycle extensions`). The review found four design issues in the `lifecycle.install` / `runtime.started` delivery and several code issues; this branch fixes them with tests. The full review comment is on #1052.

## Fixes

### 1. Install lifecycle failure was silent, unobservable, and not retryable

- `synergy plugin add` runs in a standalone CLI process where no loopback endpoint is configured, so install handlers touching `context.runtimeEndpoint.get()` always failed — yet the CLI/UI reported success and `runtime.started` catch-up never fired.
- Fix: persist `lifecycleInstall` (`pending`/`completed`/`failed`) on the lockfile entry. Inside a host process the handler runs immediately after the transaction commits; outside a host process the entry stays `pending` and is delivered at next boot (`runPendingInstallLifecycles` in `server/runtime.ts`, before the `runtime.started` broadcast) or at next plugin runtime reload (`runtime/reload.ts`, which also delivers the `runtime.started` catch-up since there is no broadcast on that path).
- `LoadedPlugin.installLifecycle` now surfaces the outcome; `synergy plugin add` prints queued/failed/completed feedback.
- New `synergy plugin retry-install <id>` re-queues failed/pending installs. A completed install is never re-run; generation mismatches fail loudly with a coded `PluginInstallLifecycleGenerationMismatchError`. Failed installs are never retried automatically.

### 2. `freshInstall` was decided from a pre-transaction snapshot

- Disabled/approval-pending config entries suppressed `lifecycle.install` for genuinely fresh installs; previously completed installs re-ran it when re-added.
- Fix: `freshInstall = oldPlugin === undefined && lockfile lifecycleInstall !== "completed"`. Fresh installs without a `lifecycle.install` contribution never write the field (retry reports "no contribution"; catch-up never reprocesses them); stale `pending` entries from earlier versions converge to `completed`.

### 3. Boot behavior

- Runtime endpoint was cleared at the start of graceful shutdown while plugins were still draining.
- Fix: cleared in a `finally` after `server.stop()`.
- Lockfile writes now use unique temp names and `persistInstallLifecycle` runs under the installation lock (concurrent read-modify-write / temp-collision hazard).

### 4. Other code issues

- `runtime.endpoint.read` is now gated per-contribution `requires` via a shared `contributionGatedCapabilities()` helper (process runner + in-process manager), matching the `agent.call` precedent.
- `SettingsPanel` uses a host-side optional-context props type; built-in panels receive no `context` (public plugin contract unchanged).
- Removed unused `peekRuntimeEndpoint()`.
- Docs updated (`runtime-and-permissions.md`, `cli.md`).

## Tests

- `packages/synergy/test/plugin/install-lifecycle.test.ts` — 14 tests: offline pending, in-host delivery, failed persist, boot catch-up, stale-generation skip, retry completed guard / offline re-queue / in-host delivery / no-contribution, stale-pending convergence, `add()`-level field-absence (real file:// fixture), reload-path trigger, boot no-trigger, generation-mismatch error.
- `packages/synergy/test/plugin-runtime/runtime-endpoint-filter.test.ts` — per-contribution gating.
- Full plugin + plugin-runtime suites: **206 pass / 0 fail / 603 expects**; oxlint and prettier clean; typecheck clean for modified files.
