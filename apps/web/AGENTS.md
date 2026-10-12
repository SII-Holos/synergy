# Web Application Rules

These rules apply under `apps/web`. Root [AGENTS.md](../../AGENTS.md) and [PRODUCT.md](PRODUCT.md) still apply.

Load `develop-frontend`; server contracts also require `change-server-api`, Channel surfaces `change-channel-runtime`, Browser controls `change-browser-runtime`, and plugin hosts/registries `change-plugin-runtime`.

## Protect the Active App

Never stop the app/server carrying this task. Inspect its URL; do not assume port `3000`. Reuse it for non-disruptive inspection or use `develop-synergy` for an isolated runtime.

## Solid State and Frontend Sync

Read [Frontend data sync](../../docs/architecture/frontend-data-sync.md) before changing contexts, session loading, composer intent, events, or reconnect behavior.

- Use a store for coherent keyed collections and targeted updates; use signals for genuinely independent scalar state.
- Apply entity writes with `reconcile` or a targeted `setStore(..., reconcile(value))`. Do not replace an entity object when one field changes.
- Read entities by stable key so reactive consumers subscribe only to the row they use.
- Preserve composer resolution layers: explicit draft → session default → fallback. A derived/historical value must not write back into the user's draft. Existing-session selector choices persist through revisioned `modelSelection`; `modelOverride` is its legacy projection.
- Preserve `seq`/`epoch` watermarks, reconnect replay, fail-open resync, unsequenced streaming deltas, write-behind behavior, and LRU protection of the active session. Do not add per-event REST refetches.
- Keep the event queue visibility-aware: hidden pages relax to a 1 s cadence and merge streaming deltas per part (server checkpoints converge), visible pages return to 16 ms with per-delta telemetry; never drop sequenced state events.
- Keep conversation rows and large Markdown blocks virtualized, preserving prepend anchors, focused controls, selections and full-history operations. Parts stay fine-grained store reads and must not move into the turn projection.
- Reconcile single messages into the sorted window incrementally (binary-search insertion) rather than re-merging and re-sorting the whole window; window order and eviction semantics stay canonical.

Discover available services through the generated capabilities API `features` before optional API calls; `components` is diagnostic metadata. Keep startup requests, settings, navigation, composer controls and workbench registrations consistent with that selection; reconnect discards the previous selection and never assumes a full product.

Use generated SDK methods for internal HTTP APIs. Add OpenAPI metadata and regenerate the SDK when a required route is missing. Keep raw browser APIs for WebSocket/EventSource, external URLs, local file/blob operations, downloads/uploads without an SDK contract, and platform fetch injection.

## Product and Interaction

Read [PRODUCT.md](PRODUCT.md) before changing interaction structure, visual hierarchy, theme behavior, navigation, workspace layout, or durable UX taste. Update it when a decision should survive future refactors.

- Preserve surface polarity: dark-mode content/selection steps brighter than its container; light-mode content/selection steps darker.
- Follow [Frontend themes and color](../../docs/reference/frontend-theming.md). Do not add Tailwind palette colors, arbitrary literal color utilities, or component-local light/dark palettes. Imperative renderers must consume the active resolved tokens and update on same-mode theme switches.
- Use semantic icon tokens from `packages/plugin/src/icons.ts` for non-tool product UI. Reuse a token only for the same user-facing meaning; add a new token and an unused glyph for a new meaning. Raw Lucide icons belong only to narrow base, file-type, tool, or plugin plumbing with an explicit reason; tool icons follow `add-tool`.
- Preserve keyboard focus, labels, WCAG AA contrast, reduced-motion behavior, loading/empty/error states, and narrow layouts.
- Register optional built-in workbench content through `WorkbenchPanelEntry.loader`. Keep Notes/Tiptap/Mermaid, Files/Monaco, Browser, Terminal, and Review implementations out of the route shell until the panel opens.
- Keep only active product fonts in the application bundle. Adding an optional font requires a user-selectable runtime path and a loading strategy; do not import dormant font families from the root `Font` component.
- Treat mobile drawers as named modal surfaces with initial focus, contained Tab traversal, Escape close, and focus return. Verify dense toolbars at 375 px and do not hide overflow that clips interactive controls.
- Gate Browser on Desktop-native capability and follow [Browser runtime](../../docs/architecture/browser-runtime.md). Keep human tab selection independent of explicit Agent targets, preserve page-scoped prompts/errors and avoid remote or simulated browser fallbacks.
- Route ordinary browser randomness through `@ericsanchezok/synergy-util/uuid`; security-sensitive randomness uses its strict APIs with no weak fallback. Keep optional Secure Context APIs out of module-scope startup paths so private-network HTTP can boot and unsupported actions fail locally.

## Settings and Plugins

- Use `src/components/settings/catalog.ts` for built-in section metadata, search terms, and domains.
- Derive field ownership from `/config/domains` `ownedKeys`; do not maintain a frontend duplicate.
- Use focused forms for common settings. For complex/low-frequency config, always show the canonical file and Copy Path; expose generated `config.domain.open` behavior only in Desktop managed-local mode where the shell and server share filesystem and desktop authority.
- Preserve the UI API 6 single-context component lifecycle, public domain services, required Shell outlets, scoped styles and owned portals. Built-ins use semantic `iconToken`; plugins may use declared plugin icons.
- Built-in settings metadata and every other Synergy-owned user-visible string use the shared Lingui runtime with explicit semantic IDs; do not add language branches, dynamic IDs, macro imports, or module-load translation calls. Keep plugin-author, user, LLM, brand, path, identifier, and raw diagnostic content verbatim. Avoid vague paired `X & Y` headings.
- Read [Plugin UI contributions](../../docs/plugins/ui-contributions.md) before changing the Web plugin host or registries.
- Read [Frontend localization](../../docs/architecture/localization.md) before adding product copy, locale-sensitive formatting, or a language setting. Update catalogs with App extraction, then run the single repository localization gate for drift, strict compilation, and the App/UI source contract.

## Verification

Keep tests under `test/`, mirroring their `src/` or `script/` domain; never colocate tests with implementation.

Keep browser conditions, isolation and timeouts in `script/test-options.ts`, shared by the package runner and CI planner.

Run the narrow UI/context test while iterating, then `bun run verify local --test apps/web/test/<domain>/<file>.test.ts` from the root with relevant tests selected. It uses the canonical executor and static gates. Complete Web/UI inventories and thresholds belong to CI; use `bun run verify coverage --package apps/web` when changing coverage policy, instrumentation or removing substantial coverage. See [develop-frontend](../../.synergy/skill/develop-frontend/SKILL.md#verify) for checks triggered by other risks.

Browser capability or bootstrap changes also run `bun test --cwd apps/web test/testing/browser-crypto-contract.test.ts` and, after the production build, `bun apps/web/script/private-http-smoke.ts` from the repository root.

Optional-feature changes verify unknown, absent, selected, removed and reinstalled states through rendered controls and request counts. Hold replies across a same-URL reconnect epoch; old results must not restore features, resume autosave or erase retained drafts.

For product copy, accessibility text, locale-sensitive formatting, or language settings, also run:

```bash
bun run --cwd apps/web i18n:extract
bun run localization:check
```

Use the existing app or an isolated second instance for interaction checks. Verify both themes, keyboard/focus, loading/error states, session switching/reconnect when relevant, and the Desktop path for native Browser or Electron behavior. Do not bypass hooks or claim unrun checks.
