# Decision Record: Global server-side plugin theme registration

Status: implemented

## Problem

Theme selection is a global user preference (config `general.theme`, read and written through scope-less `config.global()` / `config.domain.update`), but the registry serving that selection was rebuilt per scope: the Scope-scoped plugin host republished the theme registry on every scope switch, and the fallback for a missing theme destroyed the persisted choice. The user-visible incident this caused, its detection story, and why the safety nets missed it are recorded in the [postmortem](../../../postmortem/0004-scope-scoped-theme-registry.md); this record covers the architectural decision.

## Decision

Theme registration moved to a single global owner and the fallback became non-destructive:

- The server exposes `GET /plugin/ui/contributions/themes` (`plugin.listGlobalThemeContributions`, declared in `packages/synergy/src/server/plugin-routes.ts`), served without scope binding (`isGlobalRoute` allowlist entry in `packages/synergy/src/server/server.ts`). It aggregates `ui.theme` contributions from the process-wide plugin catalog (`packages/synergy/src/plugin/global-themes.ts` → `listCatalogPlugins()` in `packages/synergy/src/plugin/loader.ts`) across every enabled scope. A plugin appears once, reporting the generation of its single shared catalog entry — the plugin runtime already keeps one active generation per plugin across scopes, and the aggregate reflects whatever is currently loaded. Plugins with no enabled scope are excluded.
- The plugin asset route keeps its global resolution (it never had scope semantics) but its catalog fallback requires at least one enabled scope, because loader disposal removes the scope id while deliberately caching the catalog entry; the generation check still pins the exact requested artifact.
- The Web app registers plugin themes through `GlobalPluginThemesRegistrar` (`packages/app/src/plugin/global-themes.tsx` + the testable factory `packages/app/src/plugin/global-theme-registrar.ts`), mounted inside the router tree where it survives scope switches. It refetches on mount, when the active directory route changes, and when the plugin host's contribution list changes (marketplace install/uninstall); concurrent refreshes are generation-guarded, a failed fetch or a generation reporting asset errors retries once while keeping the last published registry generation, and dropping ownership (unmount or server change) resets the registry to not-ready. It is the only caller of `replacePluginThemes` in the app — the scope-scoped plugin host no longer touches the theme registry (`registerPluginSurfaces` and the host `onCleanup` had their theme calls removed), and the host strips `ui.theme` contributions before its asset load so themes are not double-fetched.
- When the ready registry lacks the selected theme, `ThemeProvider` (`packages/ui/src/theme/context.tsx`) keeps the selection, renders degraded default tokens, exposes `degraded()` so downstream persistence (Desktop theme sync) skips the mismatched pair, and never overwrites `synergy-skin-cache-v1`; the theme re-applies automatically once it re-enters the registry.
- The config replay side (`PluginThemeConfigBridge`, `packages/app/src/plugin/bridge.tsx`) tracks a selection-aware baseline instead of replaying the mount-time config snapshot forever: the bootstrap skin seeds the baseline, the persisted config preference applies exactly once while no local selection has happened, and any themeId change away from the baseline is adopted as the new baseline — so registry/host events (scope switches, reloads) replay the user's freshest choice rather than a stale snapshot.

## Alternatives considered

**Client-side registry merge** kept the server contract untouched and merged theme registrations incrementally per plugin id in `PluginHostProvider`. It lost because the client cannot learn about themes in scopes it never visited, so the cold-start gap would remain while adding a second registry-authority path; the user had also explicitly chosen the server-side route.

**Eagerly initializing every scope's loader** for the aggregate (`Scope.list()` + per-scope `state()`) was rejected because `resolvePluginSpec` installs non-`file://` specs (`packages/synergy/src/plugin/loader.ts`), so a global endpoint would trigger network installs and block on them; the aggregate instead reads the already-materialized catalog.

**A persisted theme index** written at scope-load time for cold-start enumeration was rejected: it adds durable state, an invalidation chain on uninstall, and migration surface for a window the non-destructive fallback already covers.

**A grace-period reset in `ThemeProvider`** (delay before resetting an unknown id) was rejected because it only masks the symptom; the scope swap still removes the theme and the cache overwrite still destroys the persisted choice.

**Placing the endpoint under `/api/plugins/themes`** was rejected: the existing single-segment `/:pluginId` routes in `ApiPluginRoute` would shadow it, and fixing that needs registration-order coupling.

## Consequences

Theme selection now behaves as the global preference it always was: switching sessions or scopes never re-registers themes, and the persisted skin choice survives registry gaps. The known boundary is lazy scope activation — after a server restart, a theme from a scope nobody has visited is absent from the global aggregate until that scope activates; the Web keeps the selection, renders degraded default tokens, and re-applies the theme on the registrar's next refetch (documented in [Plugin UI contributions](../../../plugins/ui-contributions.md) and [Frontend themes and color](../../../reference/frontend-theming.md)). The ThemePicker lists globally registered plugin themes, including those enabled only in other scopes, matching the global preference semantics. Plugin install semantics remain per scope, icon registration remains scope-scoped, and rollback is a pure code revert — no persisted state was migrated, and the skin cache is never destructively overwritten by the new code.
