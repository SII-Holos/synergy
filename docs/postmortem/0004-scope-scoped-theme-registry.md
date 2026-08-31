# 0004 — Scope-scoped theme registry flipped the skin on session switches

## Executive summary

Switching sessions could visibly flip the Synergy skin to the default and flip it back minutes later. The theme _selection_ was a global user preference while the _registry_ serving it was rebuilt per scope, and the fallback for a missing theme destroyed the persisted choice in localStorage. It escaped because every seam (host reload, registry replace, provider fallback) was individually reasonable and no test coupled the theme registry lifecycle to scope switches. The fix moved registration to a server-wide aggregate with a non-destructive degraded fallback.

## Summary

A user reported that switching sessions occasionally switched the visual theme. The selected skin (a plugin theme, e.g. `ocean-theme:ocean`) would revert to the default `synergy` skin and later return on its own. Same-scope session switches never reproduced it; cross-scope switches reproduced it deterministically only when the target scope lacked the theme plugin, and occasionally even same-scope switches triggered a transient flip.

## Timeline

- User reported probabilistic skin flips on session switches; no console errors, no persisted preference visible in Settings.
- Source tracing found three interacting owners: the plugin host reload (`PluginHostProvider` keyed on scope), the theme registry replace (`replacePluginThemes` per scope generation), and the provider fallback (`ThemeProvider` resetting unknown ids once the registry was ready).
- Runtime verification on an isolated instance confirmed the chain end-to-end and surfaced a second gap: the global theme asset URL 404'd from a non-owning scope, which alone produced the same "silently missing theme" state.
- Fix, tests, and docs landed as one PR.

## Root cause

Theme selection is global (config `general.theme`, scope-less reads/writes), but registration was scope-local: each scope switch atomically replaced the theme registry with that scope's plugin set. `ThemeProvider` treated "ready registry without the selected id" as "reset to default", and the same effect wrote the bootstrap snapshot — overwriting the persisted choice with the default skin. Recovery only happened when an unrelated registry event refilled the theme, which is why the flip appeared probabilistic and self-healing. Transient theme-asset fetch failures (reported per-asset as `errors`, not rejections) produced the identical missing-theme state. Why the safety nets missed it: registry-replacement tests asserted atomicity, not cross-scope retention; provider tests covered the reset path as intended behavior; no test coupled the two lifecycles.

## Guardrails added

- Server-wide aggregate `GET /plugin/ui/contributions/themes` + `GlobalPluginThemesRegistrar` as the single registry owner; the app-side ownership invariant is now asserted behaviorally (mount republishes, host/scope signals refetch, unmount clears) in `packages/app/test/plugin/global-themes-registrar-lifecycle.test.tsx`.
- Registrar factory tests pin that a generation reporting asset `errors` keeps the last published registry instead of publishing a partial one (`packages/app/test/plugin/global-themes.test.ts`).
- `ThemeProvider` fallback is non-destructive and covered by `packages/ui/test/theme-provider-fallback.test.ts`: selection retained, degraded default tokens, cache untouched, automatic re-apply; `degraded()` gates Desktop persistence.
- Route tests cover the global asset fallback including the disposed-scope 404 (`packages/synergy/test/server/plugin-global-theme-routes.test.ts`).
- Placement rule reinforced: the bug narrative lives here, the architecture in the [decision record](../decisions/implemented/architecture/2026-08-30-global-plugin-theme-registration.md).

## Lessons

- A global preference must not be served by a lifecycle-scoped dependency; when a preference crosses an ownership boundary, check which side each half lives on.
- A fallback that _writes_ its own degraded state converts a transient gap into a persistent failure — fallbacks should degrade in memory only.
- "Ready registry missing an id" is ambiguous between stale and invalid; only true unavailability should reset a persisted choice.
