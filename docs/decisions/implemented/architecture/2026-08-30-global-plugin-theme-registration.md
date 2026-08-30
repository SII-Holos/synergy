# Decision Record: Global server-side plugin theme registration

Status: implemented

## Problem

Switching sessions could visibly flip the Synergy skin to the default and then flip it back later. The root cause was an ownership mismatch: theme _selection_ is a global user preference (config `general.theme`, read and written through scope-less `config.global()` / `config.domain.update`), but the registry serving that selection was rebuilt per scope. `PluginHostProvider` reloaded plugin UI contributions whenever the route's scope key changed (`packages/app/src/plugin/host.tsx`), and `registerPluginSurfaces` called `replacePluginThemes` with the new scope's theme set — dropping any theme the new scope did not have. `ThemeProvider` then reset the selected `themeId` to the default skin whenever the ready registry did not contain it, and the same effect overwrote the `synergy-skin-cache-v1` bootstrap snapshot with the default skin, destroying the persisted choice in localStorage. `PluginThemeConfigBridge` could replay the config preference only when the registry itself changed, so the wrong skin stuck until the next registry event. Transient theme asset fetch failures produced the same "silently missing theme" registry state, which is why the bug appeared probabilistically.

## Decision

Theme registration moved to a single global owner and the fallback became non-destructive:

- The server exposes `GET /plugin/ui/contributions/themes` (`plugin.listGlobalThemeContributions`, declared in `packages/synergy/src/server/plugin-routes.ts`), served without scope binding (`isGlobalRoute` allowlist entry in `packages/synergy/src/server/server.ts`). It aggregates `ui.theme` contributions from the process-wide plugin catalog (`packages/synergy/src/plugin/global-themes.ts` → `listCatalogPlugins()` in `packages/synergy/src/plugin/loader.ts`) across every enabled scope. A plugin appears once with its globally newest generation and the list of scopes enabling it; plugins with no enabled scope are excluded.
- The Web app registers plugin themes through `GlobalPluginThemesRegistrar` (`packages/app/src/plugin/global-themes.tsx` + the testable factory `packages/app/src/plugin/global-theme-registrar.ts`), mounted inside the router tree where it survives scope switches. It refetches on mount, when the active directory route changes, and when the plugin host's contribution list changes (marketplace install/uninstall); concurrent refreshes are generation-guarded, and a failed fetch retries once after 2 s while keeping the last published registry generation. It is the only caller of `replacePluginThemes` in the app — the scope-scoped plugin host no longer touches the theme registry (`registerPluginSurfaces` and the host `onCleanup` had their theme calls removed), and the host strips `ui.theme` contributions before its asset load so themes are not double-fetched.

## Alternatives considered

**Client-side registry merge** kept the server contract untouched and merged theme registrations incrementally per plugin id in `PluginHostProvider`. It lost because the client cannot learn about themes in scopes it never visited, so the cold-start gap would remain while adding a second registry-authority path; the user had also explicitly chosen the server-side route.

**Eagerly initializing every scope's loader** for the aggregate (`Scope.list()` + per-scope `state()`) was rejected because `resolvePluginSpec` installs non-`file://` specs (`packages/synergy/src/plugin/loader.ts`), so a global endpoint would trigger network installs and block on them; the aggregate instead reads the already-materialized catalog.

**A persisted theme index** written at scope-load time for cold-start enumeration was rejected: it adds durable state, an invalidation chain on uninstall, and migration surface for a window the non-destructive fallback already covers.

**A grace-period reset in `ThemeProvider`** (delay before resetting an unknown id) was rejected because it only masks the symptom; the scope swap still removes the theme and the cache overwrite still destroys the persisted choice.

**Placing the endpoint under `/api/plugins/themes`** was rejected: the existing single-segment `/:pluginId` routes in `ApiPluginRoute` would shadow it, and fixing that needs registration-order coupling.

## Consequences

Theme selection now behaves as the global preference it always was: switching sessions or scopes never re-registers themes, and the persisted skin choice survives registry gaps. The known boundary is lazy scope activation — after a server restart, a theme from a scope nobody has visited is absent from the global aggregate until that scope activates; the Web keeps the selection, renders degraded default tokens, and re-applies the theme on the registrar's next refetch (documented in [Plugin UI contributions](../../../plugins/ui-contributions.md) and [Frontend themes and color](../../../reference/frontend-theming.md)). The ThemePicker lists globally registered plugin themes, including those enabled only in other scopes, matching the global preference semantics. Plugin install semantics remain per scope, icon registration remains scope-scoped, and rollback is a pure code revert — no persisted state was migrated, and the skin cache is never destructively overwritten by the new code.
