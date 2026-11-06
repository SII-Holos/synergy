# Shared UI Package Rules

Shared Solid UI follows Root `AGENTS.md`, `apps/web/AGENTS.md`, and `apps/web/PRODUCT.md`.

Load `develop-frontend`; plugin registries also require `change-plugin-runtime`.

## Preserve the Shared Boundary

- Keep components product-agnostic and dependency-light. Do not import app contexts, routes, or runtime-private modules into this package.
- Prefer composition and typed props over package-global product state. Preserve controlled/uncontrolled behavior, stable callbacks, cleanup, and Solid fine-grained reactivity.
- Consume the App-owned Lingui `I18nProvider` through peer dependencies. Do not own catalogs, detect browser language, persist locale, or import App locale contexts. Tests mount the shared i18n provider.
- Product copy uses non-macro descriptors, explicit semantic IDs and reactive translation. Preserve user, LLM, plugin-author, brand, path, identifier, code, terminal and diagnostic text verbatim. Format with the active Lingui locale or a typed locale.
- Keep keyboard access, labels, focus-visible behavior, WCAG AA contrast, reduced motion, loading/empty/error/disabled states, and narrow layouts in reusable primitives.
- Non-tool product meaning uses `semantic-icon.tsx`; new base glyphs must exist in both `components/icon.tsx` and `plugin/builtin-icons.ts`. Tool cards, file icons, and plugin-declared icons keep their separate registries.
- Shared scroll surfaces declare native vertical viewport ownership for Markdown as defined in [frontend data sync](../../docs/architecture/frontend-data-sync.md#markdown-terminal-handoff).
- Resource controls share `ResourceReference` parsing, the Markdown resource observer and `ResourceOpenController.open`; App owns opening policy.
- Preserve Markdown sanitization, streaming/terminal rendering bounds, attachment behavior, and theme polarity. Treat SVG and rendered HTML as untrusted input at their owning boundary.
- `packages/plugin/src/theme` owns the published color contract; `src/theme/*` owns compatibility facades, Solid application, the single registry and shell snapshots. Themes supply validated light/dark seeds and typed overrides. Built-ins pre-register in `src/theme/default-themes.ts`; only `themes/synergy.json` adds curated overrides. Plugins share the registry without shadowing built-in ids. Run `bun run generate:theme` after contract/built-in changes; never edit generated CSS, schema or Web/Desktop fallbacks.
- Consumer color utilities must name canonical tokens. Add or change a semantic token at the theme boundary instead of inventing component-local aliases such as `*-soft`, `*-muted`, or unregistered foreground names. Keep status foreground/surface pairs at WCAG AA contrast.
- Follow [Frontend themes and color](../../docs/reference/frontend-theming.md). New distributable themes use structured plugin contributions.
- Consume compaction status through the public `compaction-card` presentation resolver.
- Public exports are package contracts. Add exports deliberately and keep App-only components in `apps/web`.
- `DataProvider.hasFeature` carries host-confirmed services. Public `tool-result-presentation` helpers gate specialized cards and resource jumps; unknown or missing owners stay hidden. Preserve ordinary transcript text and attachments, never structured control metadata.
- `DataProvider.view` accepts a host-owned read-only session projection; `data` remains the canonical store. Local submission overlays belong to the App and must retain message and Part identities through canonical admission.
- `RenderProvider` follows [visual ownership](../../docs/architecture/visual-results.md): UI owns sandboxed presentation; App owns Scope, state operations and confirmed Inbox inputs.

## Verify

Keep tests under `test/`, mirroring their `src/` domain; never colocate tests with implementation.

Keep browser conditions, isolation and timeouts in `script/test-options.ts`, shared by the package runner and CI planner.

Capability-dependent presentation tests mount real components with unknown, removed and restored selections. Assert specialized cards and resource actions disappear while ordinary transcript text and attachments survive; an older host epoch cannot restore removed presentation.

Run the narrow test, `bun test test/semantic-icon.test.ts` for icon changes, and `bun test test/theme.test.ts test/theme-generation.test.ts` for theme changes. Then run `bun run test` and `bun run typecheck`. Exercise affected components through the App when visual or interaction behavior changed, and finish with root `bun run quality:quick`.

For Synergy-owned copy in shared UI, run the App-owned shared-catalog gates from the repository root:

```bash
bun run --cwd apps/web i18n:extract
bun run localization:check
```
