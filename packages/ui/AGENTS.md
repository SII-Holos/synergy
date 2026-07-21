# Shared UI Package Rules

These rules apply to reusable Solid components, rendering, styles, themes, icon registries, and plugin UI primitives. Root `AGENTS.md`, `packages/app/AGENTS.md`, and `packages/app/PRODUCT.md` define the consuming product contract.

Load `develop-frontend` for shared UI changes and `change-plugin-runtime` for plugin registries or contribution primitives.

## Preserve the Shared Boundary

- Keep components product-agnostic and dependency-light. Do not import app contexts, routes, or runtime-private modules into this package.
- Prefer composition and typed props over package-global product state. Preserve controlled/uncontrolled behavior, stable callbacks, cleanup, and Solid fine-grained reactivity.
- Shared product components consume the App-owned Lingui `I18nProvider` through `@lingui/core` and `@lingui/solid` peer dependencies. The UI package does not create a second locale context, own catalogs, inspect browser language, or persist locale state. Tests mount the shared i18n test provider.
- Synergy-owned copy uses non-macro runtime descriptors with explicit semantic IDs and translates reactively at consumption. Keep user, LLM, plugin-author, brand, path, identifier, code, terminal, and raw diagnostic content verbatim. Do not import App locale contexts into this package; format with the active Lingui locale or a typed locale argument.
- Keep keyboard access, labels, focus-visible behavior, WCAG AA contrast, reduced motion, loading/empty/error/disabled states, and narrow layouts in reusable primitives.
- Non-tool product meaning uses `semantic-icon.tsx`; new base glyphs must exist in both `components/icon.tsx` and `plugin/builtin-icons.ts`. Tool cards, file icons, and plugin-declared icons keep their separate registries.
- Preserve Markdown sanitization, streaming/terminal rendering bounds, attachment behavior, and theme polarity. Treat SVG and rendered HTML as untrusted input at their owning boundary.
- The published color contract is owned by `packages/plugin/src/theme`; `src/theme/*` keeps compatibility facades and owns Solid runtime application, registries, and shell snapshots. Themes provide validated light/dark seeds plus typed overrides. Run `bun run generate:theme` after changing the contract or built-in theme and do not hand-edit generated CSS, schema, Web boot fallback, or Desktop fallback skin.
- Consumer color utilities must name canonical tokens. Add or change a semantic token at the theme boundary instead of inventing component-local aliases such as `*-soft`, `*-muted`, or unregistered foreground names. Keep status foreground/surface pairs at WCAG AA contrast.
- Follow [Frontend themes and color](../../docs/reference/frontend-theming.md) for the complete consumer contract and theme-authoring workflow. New selectable themes belong in structured plugin contributions; `themes/synergy.json` owns only the built-in default.
- Public exports are package contracts. Add exports deliberately and keep App-only components in `packages/app`.

## Verify

Run the narrow test, `bun test test/semantic-icon.test.ts` for icon changes, and `bun test test/theme.test.ts test/theme-generation.test.ts` for theme changes. Then run `bun run test` and `bun run typecheck`. Exercise affected components through the App when visual or interaction behavior changed, and finish with root `bun run quality:quick`.

For Synergy-owned copy in shared UI, run the App-owned shared-catalog gates from the repository root:

```bash
bun run --cwd packages/app i18n:extract
bun run localization:check
```
