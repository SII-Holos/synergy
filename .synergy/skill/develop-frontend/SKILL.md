---
name: develop-frontend
description: Implement or review Synergy Web and shared UI changes across packages/app and packages/ui. Use for components, contexts/stores, navigation, settings, dialogs, workbench surfaces, semantic icons, themes, responsive behavior, accessibility, frontend API calls, event sync, and product interaction changes.
---

# Develop the Frontend

## Read the Contracts

1. Read `packages/app/AGENTS.md` and [Web product contract](../../../packages/app/PRODUCT.md).
2. Read [Frontend data sync](../../../docs/architecture/frontend-data-sync.md) for contexts, snapshots, events, streaming, composer intent, or loaded buckets.
3. Read [Browser runtime](../../../docs/architecture/browser-runtime.md) for Browser UI or Desktop/Web presentation changes.
4. Load `change-server-api` when the UI needs a new or changed server contract; load `add-tool` for tool-card presentation.

## Preserve State and API Ownership

1. Use stores for coherent keyed collections and signals for independent scalar state.
2. Apply entity updates with targeted setters and `reconcile`; do not replace a whole stored object for a one-field event.
3. Keep derived values one-way. Preserve composer resolution as explicit draft → session default → fallback; only explicit user choices persist upward.
4. Use generated SDK methods for ordinary internal HTTP routes. Keep raw browser transports only for WebSocket/EventSource/WebRTC, external URLs, platform fetch injection, and browser file/blob/download flows that the SDK should not represent.
5. Preserve Scope/directory parameters, authentication, error semantics, asset URLs, event `seq`/`epoch`, replay, and loading/error states.

## Use Semantic Icons

Non-tool product UI expresses meaning through `packages/ui/src/components/semantic-icon.tsx`.

1. Name the user-facing meaning before choosing a glyph.
2. Reuse an existing token only when the new control has the same meaning. Similar appearance or location is not enough.
3. Add a new token to `packages/ui/src/components/semantic-icon.tsx` before using an icon for a new product entity, navigation concept, state, setting, command, or action.
4. Choose a built-in glyph that is not already mapped to another semantic token. Reuse the existing token when the meaning is truly identical; do not create a second token that aliases its glyph.
5. When the glyph is new to the shared Icon component, register it in both `packages/ui/src/components/icon.tsx` and `packages/ui/src/plugin/builtin-icons.ts` before referencing it from the semantic map.
6. Render through `getSemanticIcon(token)` and type stored metadata as `SemanticIconTokenName`.
7. Keep raw icon names inside base icon controls, file-type/icon registries, tool-card plumbing, or plugin-provided icon paths. Built-in Plugin host UI still uses semantic tokens. Tool icons follow `add-tool`, not the product semantic-token registry.

Run `bun test test/semantic-icon.test.ts` from `packages/ui`. It rejects duplicate glyph mappings, missing shared registrations, raw JSX icon literals, and raw icon object metadata outside the documented base/tool/plugin-data exceptions.

## Preserve Product Presentation

1. Reuse shared workbench, dialog, form, toolbar, and surface primitives before creating local variants.
2. Preserve polarity: dark content/selection surfaces step brighter inward; light surfaces step darker inward.
3. Use semantic color/type/spacing tokens. Reserve state colors for real state rather than decoration.
4. Keep controls labeled, keyboard reachable, focus-visible, WCAG AA, reduced-motion safe, and usable at narrow widths.
5. Implement loading, empty, error, disabled, and reconnect states as first-class behavior.
6. Update `PRODUCT.md` when an interaction or visual rule should survive refactors.

## Preserve Loading Boundaries

1. Register optional built-in workbench panels with `WorkbenchPanelEntry.loader`; do not statically import Notes, Files, Browser, Terminal, or Review implementations into the route shell.
2. Keep heavyweight feature engines behind the interaction that needs them: Tiptap and Mermaid behind Notes, Monaco behind file Source view, and Ghostty behind Terminal.
3. Import only fonts used by the active product typography contract. A dormant family must not be emitted by the default App build.
4. Preserve `packages/app/src/app-build-css-contract.test.ts` as the production build regression gate for initial module preloads, emitted product fonts, and core compiled CSS.

## Change Themes and Color Tokens

Read `docs/reference/frontend-theming.md` before changing the color contract, adding a semantic token, integrating an imperative renderer, or authoring a selectable theme.

1. Use `packages/ui/src/theme/tokens.ts` as the exhaustive color-token catalog and `resolve.ts` as the only palette resolver. A theme supplies light/dark seeds plus optional typed overrides; do not create a parallel CSS palette.
2. Use a canonical token in Tailwind utilities and CSS variables. If the required meaning is absent, add it to the token catalog and resolver before using it. Do not invent consumer aliases such as `surface-*-soft`, `surface-muted`, or unregistered status text names.
3. Edit `packages/ui/src/theme/themes/synergy.json` for Synergy-specific seed or override values. Run `bun run --cwd packages/ui generate:theme`; never hand-edit `theme.generated.css`, `tailwind/colors.css`, or `theme.schema.json`.
4. Keep common text/background and status foreground/surface pairs at WCAG AA contrast in both modes. Preserve the product polarity rule independently of accent hue.
5. Plugin themes are complete structured JSON themes validated by the same schema and resolved by the same runtime. Do not add arbitrary plugin CSS theme overrides or theme-only token paths.
6. Imperative consumers such as Canvas, Monaco, terminals, and embedded documents must use the resolved theme tokens and react to the canonical theme-change event. Do not maintain component-local light/dark palettes or infer a theme change only from `data-color-scheme`.
7. Run the theme contract, artifact parity, and consumer-utility tests before visual inspection:

```bash
bun test --cwd packages/ui test/theme.test.ts test/theme-generation.test.ts
bun test --cwd packages/app src/testing/color-token-contract.test.ts
```

## Verify

1. Run the narrow component, model, or context test first.
2. Run:

```bash
bun run --cwd packages/app test
bun run --cwd packages/app typecheck
bun run --cwd packages/ui test
bun run --cwd packages/app build
```

3. Inspect both themes, keyboard/focus, narrow layout, and loading/error behavior in an existing app or isolated second runtime.
4. At 375 px, check that overlay surfaces are named and keyboard-contained and that every interactive control remains inside the viewport. Open each changed lazy panel once to prove its implementation and resources still load.
5. Exercise Desktop when native Browser, window chrome, protocol, or Electron behavior changed.
6. Finish with `bun run quality:quick` when the change is ready for repository review.

## Handoff

Report state ownership, API path, semantic icon token, shared primitives, accessibility states, tests, visual checks, and any durable `PRODUCT.md` or Skill update.
