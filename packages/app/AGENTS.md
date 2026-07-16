# Web Application Rules

These rules apply under `packages/app`. Root [AGENTS.md](../../AGENTS.md) and [PRODUCT.md](PRODUCT.md) still apply.

Load `develop-frontend` for the complete Web/shared UI workflow, `change-server-api` when the change needs a new or modified server contract, `change-browser-runtime` for Browser presentation/control, and `change-plugin-runtime` for the built-in plugin host or registries.

## Protect the Active App

Do not restart or stop the Web app or server carrying the current task. Inspect the current dev URL before testing; do not assume port `3000`. Use the existing app for non-disruptive inspection or start an isolated second runtime through the `develop-synergy` skill.

## Solid State and Frontend Sync

Read [Frontend data sync](../../docs/architecture/frontend-data-sync.md) before changing contexts, session loading, composer intent, events, or reconnect behavior.

- Use a store for coherent keyed collections and targeted updates; use signals for genuinely independent scalar state.
- Apply entity writes with `reconcile` or a targeted `setStore(..., reconcile(value))`. Do not replace an entity object when one field changes.
- Read entities by stable key so reactive consumers subscribe only to the row they use.
- Preserve composer resolution layers: explicit draft → session default → fallback. A derived/historical value must not write back into the user's draft; an explicit selector choice persists through `modelOverride`.
- Preserve `seq`/`epoch` watermarks, reconnect replay, fail-open resync, unsequenced streaming deltas, write-behind behavior, and LRU protection of the active session. Do not add per-event REST refetches.

Use generated SDK methods for internal HTTP APIs. Add OpenAPI metadata and regenerate the SDK when a required route is missing. Keep raw browser APIs for WebSocket/EventSource/WebRTC, external URLs, local file/blob operations, downloads/uploads without an SDK contract, and platform fetch injection.

## Product and Interaction

Read [PRODUCT.md](PRODUCT.md) before changing interaction structure, visual hierarchy, theme behavior, navigation, workspace layout, or durable UX taste. Update it when a decision should survive future refactors.

- Preserve surface polarity: dark-mode content/selection steps brighter than its container; light-mode content/selection steps darker.
- Follow [Frontend themes and color](../../docs/reference/frontend-theming.md). Do not add Tailwind palette colors, arbitrary literal color utilities, or component-local light/dark palettes. Imperative renderers must consume the active resolved tokens and update on same-mode theme switches.
- Use semantic icon tokens from `packages/ui/src/components/semantic-icon.tsx` for non-tool product UI. Reuse a token only for the same user-facing meaning; add a new token and an unused glyph for a new meaning. Raw Lucide icons belong only to narrow base, file-type, tool, or plugin plumbing with an explicit reason; tool icons follow `add-tool`.
- Preserve keyboard focus, labels, WCAG AA contrast, reduced-motion behavior, loading/empty/error states, and narrow layouts.
- Register optional built-in workbench content through `WorkbenchPanelEntry.loader`. Keep Notes/Tiptap/Mermaid, Files/Monaco, Browser, Terminal, and Review implementations out of the route shell until the panel opens.
- Keep only active product fonts in the application bundle. Adding an optional font requires a user-selectable runtime path and a loading strategy; do not import dormant font families from the root `Font` component.
- Treat mobile drawers as named modal surfaces with initial focus, contained Tab traversal, Escape close, and focus return. Verify dense toolbars at 375 px and do not hide overflow that clips interactive controls.
- Keep Browser native and remote presentations consistent with [Browser runtime](../../docs/architecture/browser-runtime.md); do not introduce iframe, screenshot-stream, pseudo-tab, or multi-page fallbacks.

## Settings and Plugins

- Use `src/components/settings/catalog.ts` for built-in section metadata, search terms, domains, and save strategies.
- Derive field ownership from `/config/domains` `ownedKeys`; do not maintain a frontend duplicate.
- Use focused forms for common settings. For complex/low-frequency config, always show the canonical file and Copy Path; expose generated `config.domain.open` behavior only in Desktop managed-local mode where the shell and server share filesystem and desktop authority.
- Preserve plugin-contributed settings and UI lifecycle. Built-ins use semantic `iconToken`; plugins may use declared plugin icons.
- Keep built-in settings labels in English and avoid vague paired `X & Y` headings.
- Read [Plugin UI contributions](../../docs/plugins/ui-contributions.md) before changing the Web plugin host or registries.

## Verification

Run the narrow UI/context test first, then:

```bash
bun run --cwd packages/app test
bun run --cwd packages/app typecheck
bun run --cwd packages/app build
bun run quality:quick
```

Use the existing app or an isolated second instance for interaction checks. Verify both themes, keyboard/focus, loading/error states, session switching/reconnect when relevant, and the Desktop path for native Browser or Electron behavior. Do not bypass hooks or claim unrun checks.
