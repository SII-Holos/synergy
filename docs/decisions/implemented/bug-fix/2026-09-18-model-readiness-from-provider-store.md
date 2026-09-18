# Decision Record: Derive model readiness from the global provider store

Status: implemented

## Problem

The Web shell showed an "AI model not configured" strip whenever the startup health probe reported `modelReady: false`, and it never went away after the user configured a provider in Settings.

The signal was cached rather than derived. `apps/web/src/context/server.tsx` wrote `modelReady` in exactly one place — the health `createEffect`, which re-runs only when the active server URL changes or `refreshToken` increments. Neither caller of `refresh()` (the connection-error retry button and the managed-server update reconnect) runs when a provider is configured. Configuring a provider refreshes a different store: `globalSync.refreshProviders()` resolves to `refreshTargeted(["provider"])`, which writes only the `provider` and `provider_auth` buckets. The `config.updated`, `runtime.reloaded`, and `provider.auth.updated` handlers refresh config, providers, and auth health, and none re-reads health. Desktop compounded it by polling no health at all, so its only recovery was a full page reload.

A cold-start false negative made the strip appear even with a working model. `Server.resolveHealthModelReady` races the provider build against a one-second window and falls back to `lastSettledProviders`, which is `undefined` before the first build, so it can answer `false` while a model is configured. The frontend cached that `false` permanently.

## Decision

- Model readiness is derived, not probed. `resolveModelReadiness(provider: ProviderListResponse)` in `apps/web/src/components/provider/model-readiness.ts` is the single authority, answering whether at least one provider exposes a usable model: `runtimeAvailability[providerID].available === true` for a provider in `connected`.
- The result is a discriminated union with three distinguishable blocking reasons: `not-configured` (nothing is connected), `needs-attention` (a connected provider's auth health is `action_required` or `exhausted`), and `restricted` (connected and authenticated, but blocked by `disabled`, `no_models`, or `not_connected`). Evaluation order is `ready`, `not-configured`, `needs-attention`, `restricted`, and `needs-attention` and `restricted` carry their affected `providerIDs` sorted for determinism.
- `ModelUnavailableBanner` renders from that derivation inside `GlobalSyncProvider`, as a full-width strip after `DesktopNativeTitlebar` and before `ConnectionBanner`. It reads the global snapshot only — never the per-scope provider store, whose contents are project-overridable and would let an app-wide surface flicker with the active project. `GlobalSyncProvider` gates its children on `ready`, and `bootstrap()` populates `provider` before flipping it, so the strip cannot flash during load.
- The strip is actionable. Its primary control opens `SettingsDialog initialTab="providers"`, passing `providerFocusID` only when exactly one provider is affected. The terminal command from the replaced message is demoted to secondary body text.
- The dead frontend probe state is deleted: the `modelReady` signal, its reset, its assignment, and its returned field are gone from `apps/web/src/context/server.tsx`. `healthy`, `refresh()`, `startupView`, and the health effect are otherwise unchanged.
- The server contract is untouched. `GET /global/health` still returns `modelReady`, `Server.resolveHealthModelReady` keeps its bounded wait, and the CLI start note keeps reading the field. The health probe is a startup and diagnostic signal, not a UI readiness source.

## Alternatives considered

**Keep `server.modelReady()` and invalidate it explicitly.** Add `server.refresh()` to every `ProvidersPanel` call site, `ProviderConnectionFlow.complete()`, `GitHubPanel`, and the `runtime.reloaded`/`provider` event path, and write `modelReady` in `refreshHealth()`. Rejected: this preserves the defect's shape — a one-shot cached probe that every present and future configuration entry point must remember to invalidate, which is exactly how the bug arose. It also leaves the cold-start false negative in place.

**Poll health and write readiness from the existing interval.** `refreshHealth()` already fetches the field and discards it, but the shortest Web interval is five minutes and Desktop has no server-health polling by design. Rejected: latency measured in minutes does not satisfy "clears when the user configures", and it would add polling the sync architecture avoids.

**Fix only the server-side bounded wait.** `resolveHealthModelReady` and `HEALTH_PROVIDER_WAIT_MS = 1000` exist because the daemon probe aborts at 1.2 s and the CLI probe at 3 s. Rejected: waiting longer regresses startup readiness detection for those consumers, and it leaves the invalidation defect untouched, so the strip would still stick after a Settings change.

**Reuse the per-scope provider store for the banner.** Rejected: the banner is app-wide, while `refreshConfig(scopeKey)` also writes a scope-local `provider` bucket whose `enabled_providers` / `disabled_providers` contents can differ per project. An app-level surface must not flicker with the active project, and Settings itself reads the global snapshot.

**Lift readiness into `app.tsx` by prop-drilling or a second lightweight context.** Rejected: the strip previously rendered above `GlobalSyncProvider` and could not use `useGlobalSync()` there. A parallel store would duplicate the sync owner that [Frontend data sync](../../../architecture/frontend-data-sync.md) designates.

**Replace the strip with an inline model-picker empty state, or keep it passive with terminal-only copy.** Both were offered and declined: the top strip's position and form are preserved, and because the GUI is an equal provider-configuration surface, the primary affordance must be the GUI action rather than a terminal command.

## Consequences

Configuring, importing, or refreshing a provider in Settings clears the strip because the store Settings already refreshes is the strip's only input; correctness follows from construction instead of from every mutation site remembering to invalidate a cache. Desktop, which has no health polling, gains the same live clearing without a reload. A user who already has a usable model — including one configured only through environment variables — never sees the strip, so the cold-start false negative can no longer surface in the UI even though the bounded probe still answers conservatively for the CLI and daemon consumers.

The trade-off is that readiness now depends on the provider snapshot being populated, which is why the strip must stay inside the synchronized shell; rendering it earlier would briefly produce `not-configured`. Three user-visible reasons now exist, so new blocking situations need a deliberate placement in the union rather than silently falling through, and the copy must keep raw provider failure codes in Settings diagnostics rather than the strip.
