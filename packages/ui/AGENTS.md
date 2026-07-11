# Shared UI Package Rules

These rules apply to reusable Solid components, rendering, styles, themes, icon registries, and plugin UI primitives. Root `AGENTS.md`, `packages/app/AGENTS.md`, and `packages/app/PRODUCT.md` define the consuming product contract.

Load `develop-frontend` for shared UI changes and `change-plugin-runtime` for plugin registries or contribution primitives.

## Preserve the Shared Boundary

- Keep components product-agnostic and dependency-light. Do not import app contexts, routes, or runtime-private modules into this package.
- Prefer composition and typed props over package-global product state. Preserve controlled/uncontrolled behavior, stable callbacks, cleanup, and Solid fine-grained reactivity.
- Keep keyboard access, labels, focus-visible behavior, WCAG AA contrast, reduced motion, loading/empty/error/disabled states, and narrow layouts in reusable primitives.
- Non-tool product meaning uses `semantic-icon.tsx`; new base glyphs must exist in both `components/icon.tsx` and `plugin/builtin-icons.ts`. Tool cards, file icons, and plugin-declared icons keep their separate registries.
- Preserve Markdown sanitization, streaming/terminal rendering bounds, attachment behavior, and theme polarity. Treat SVG and rendered HTML as untrusted input at their owning boundary.
- Treat `src/theme/tokens.ts` as the complete color-token contract. Themes provide validated light/dark seeds plus typed overrides; `src/theme/resolve.ts` produces every token. Run `bun run generate:theme` after changing either source and do not hand-edit `styles/theme.generated.css`, `styles/tailwind/colors.css`, or `theme/theme.schema.json`.
- Consumer color utilities must name canonical tokens. Add or change a semantic token at the theme boundary instead of inventing component-local aliases such as `*-soft`, `*-muted`, or unregistered foreground names. Keep status foreground/surface pairs at WCAG AA contrast.
- Public exports are package contracts. Add exports deliberately and keep App-only components in `packages/app`.

## Verify

Run the narrow test, `bun test test/semantic-icon.test.ts` for icon changes, and `bun test test/theme.test.ts test/theme-generation.test.ts` for theme changes. Then run `bun run test` and `bun run typecheck`. Exercise affected components through the App when visual or interaction behavior changed, and finish with root `bun run quality:quick`.
