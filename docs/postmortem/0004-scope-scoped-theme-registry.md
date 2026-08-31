# 0004 — Scope-scoped theme registry flipped the skin on session switches

## Executive summary

Switching sessions could visibly flip the Synergy skin to the default and flip it back minutes later. The theme _selection_ was a global user preference while the _registry_ serving it was rebuilt per scope, and the fallback for a missing theme destroyed the persisted choice in localStorage. It escaped because every seam (host reload, registry replace, provider fallback) was individually reasonable and no test coupled the theme registry lifecycle to scope switches. The fix moved registration to a server-wide aggregate with a non-destructive degraded fallback.

## Summary

A user reported that switching sessions occasionally switched the visual theme. The selected skin (a plugin theme, e.g. `ocean-theme:ocean`) would revert to the default `synergy` skin and later return on its own. Same-scope session switches never reproduced it; cross-scope switches reproduced it deterministically only when the target scope lacked the theme plugin, and occasionally even same-scope switches triggered a transient flip.

## Timeline

- User reported probabilistic skin flips on session switches; no console errors, no persisted preference visible in Settings.
- Source tracing found three interacting owners: the plugin host reload (`PluginHostProvider` keyed on scope), the theme registry replace (`replacePluginThemes` per scope generation), and the provider fallback (`ThemeProvider` resetting unknown ids once the registry was ready).
- Runtime verification on an isolated instance confirmed the chain end-to-end and surfaced a second gap: the global theme asset URL 404'd from a non-owning scope, which alone produced the same "silently missing theme" state.
- User verification on the isolated instance after the registry fix surfaced a second mechanism with a tighter loop: a fresh selection was lost on the very next session switch, a hard refresh restored it, and selecting again re-broke it. That signature pointed at a stale replay source rather than the registry lifecycle.
- Fix, tests, and docs landed as one PR.

## Root cause

Theme selection is global (config `general.theme`, scope-less reads/writes), but registration was scope-local: each scope switch atomically replaced the theme registry with that scope's plugin set. `ThemeProvider` treated "ready registry without the selected id" as "reset to default", and the same effect wrote the bootstrap snapshot — overwriting the persisted choice with the default skin. Recovery only happened when an unrelated registry event refilled the theme, which is why the flip appeared probabilistic and self-healing. Transient theme-asset fetch failures (reported per-asset as `errors`, not rejections) produced the identical missing-theme state. Why the safety nets missed it: registry-replacement tests asserted atomicity, not cross-scope retention; provider tests covered the reset path as intended behavior; no test coupled the two lifecycles.

The replay side had the same ownership disease in miniature: `PluginThemeConfigBridge` fetched the config preference once at mount (`createResource` with no refetch source). Selections made in the UI persist server-side immediately, so the mount-time snapshot went stale the moment the user picked a theme; the next registry or host event replayed the stale value over the fresh selection. A hard refresh re-fetched the now-persisted preference (works), until the next selection re-staled the snapshot — hence "force refresh fixes it, selecting again breaks it". The subtler variant survived the first fix's per-instance baseline: session transitions remount the plugin bridge, resetting that baseline exactly when a remount-time config fetch races the selection's fire-and-forget PATCH and still observes the old preference. The final fix records selections in module state for the page's lifetime (`packages/app/src/plugin/theme-selection.ts`) — selection recording survives bridge remounts, and the config preference is authoritative only while no selection has been recorded in this page.

## Guardrails added

- Server-wide aggregate `GET /plugin/ui/contributions/themes` + `GlobalPluginThemesRegistrar` as the single registry owner; the app-side ownership invariant is now asserted behaviorally (mount republishes, host/scope signals refetch, unmount clears) in `packages/app/test/plugin/global-themes-registrar-lifecycle.test.tsx`.
- Registrar factory tests pin that a generation reporting asset `errors` keeps the last published registry instead of publishing a partial one (`packages/app/test/plugin/global-themes.test.ts`).
- `ThemeProvider` fallback is non-destructive and covered by `packages/ui/test/theme-provider-fallback.test.ts`: selection retained, degraded default tokens, cache untouched, automatic re-apply; `degraded()` gates Desktop persistence.
- Route tests cover the global asset fallback including the disposed-scope 404 and the declared-theme-asset-only restriction — arbitrary files in a plugin directory stay unreadable through the scope-less route (`packages/synergy/test/server/plugin-global-theme-routes.test.ts`).
- The config bridge replays a server-keyed selection record covered by `packages/app/test/plugin/theme-config-bridge.test.ts`: a selection survives registry/host events and bridge remounts despite the stale snapshot (including a remount-time config fetch racing the selection PATCH), the persisted preference applies while no selection was recorded, a selection made before the config resolves wins, a definitively removed theme drops the record and converges on the cleared preference, a transient gap refetches once without looping, and the record never leaks across a server change. Uninstall-side preference cleanup is covered by `packages/synergy/test/plugin/uninstall.test.ts`.
- Placement rule reinforced: the bug narrative lives here, the architecture in the [decision record](../decisions/implemented/architecture/2026-08-30-global-plugin-theme-registration.md).

## Lessons

- A global preference must not be served by a lifecycle-scoped dependency; when a preference crosses an ownership boundary, check which side each half lives on.
- A fallback that _writes_ its own degraded state converts a transient gap into a persistent failure — fallbacks should degrade in memory only.
- "Ready registry missing an id" is ambiguous between stale and invalid; only true unavailability should reset a persisted choice.
