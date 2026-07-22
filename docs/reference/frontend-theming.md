# Frontend Themes and Color

Synergy has one frontend color contract shared by the Web app, reusable UI components, Desktop-hosted Web surfaces, and plugin themes. A selectable theme changes the values behind that contract; it does not introduce another palette or a component-specific theme path.

## Canonical Ownership

| Concern                                                        | Canonical source                                                                            |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Public token names, seed contract, resolver, schema, and types | `packages/plugin/src/theme/` and `@ericsanchezok/synergy-plugin/theme`                      |
| Built-in Synergy seed and override values                      | `packages/ui/src/theme/themes/synergy.json`                                                 |
| Runtime selection and application                              | `packages/ui/src/theme/context.tsx` and `application.ts`                                    |
| Plugin theme registration                                      | `packages/ui/src/theme/plugin-theme-registry.ts` and `packages/app/src/plugin/ui-assets.ts` |
| Web/Desktop shell snapshot                                     | `packages/ui/src/theme/shell-skin.ts` and `packages/desktop/src/theme.ts`                   |

The UI package keeps compatibility re-exports for the public contract. The generated static CSS, Tailwind mappings, JSON Schema, Web boot fallback, and Desktop fallback skin are outputs. Never edit them by hand. Regenerate them with:

```bash
bun run --cwd packages/ui generate:theme
```

## Rules for Frontend Consumers

Use the semantic meaning of a color, not its hue. Product code should use classes such as `bg-surface-raised-base`, `text-text-on-critical-base`, and `border-border-weak-base`, or the corresponding `var(--token-name)` custom property.

- Do not add Tailwind palette utilities such as `text-blue-500`, `bg-black/40`, or `border-zinc-700`.
- Do not add arbitrary literal color utilities such as `bg-[rgba(...)]` or `text-[#...]`.
- Do not create a component-local light/dark palette, hue map, or aliases such as `surface-muted`, `panel-soft`, or `chart-blue`.
- Do not use status colors as decoration. Choose `success`, `warning`, `critical`, or `info` only when that meaning is present.
- Use ordinal `chart-series-*` tokens for categorical visualization colors. The default series palette is derived from the theme's `primary` seed in OKLCH and can be overridden token by token. Do not borrow status or avatar tokens because their hue looks convenient.
- Reuse an existing token only when its semantic role matches. If no role exists, add one canonical token and resolve it for every theme instead of inventing a consumer-only variable.
- Keep the polarity invariant: dark-mode content and selected surfaces step brighter than their containers; light-mode content and selected surfaces step darker.
- Text/background and status foreground/surface pairs must meet WCAG AA contrast in both modes.

Literal colors belong only at the theme-authoring boundary, in color-generation math, or in genuinely user/external-authored content. A new product color outside those boundaries is a theme-contract change and needs a semantic token.

### Imperative renderers

Canvas, Chart.js, Monaco, terminal engines, SVG renderers, and isolated documents cannot assume that a CSS custom-property string is directly usable. Read the active resolved theme and flatten references with `resolveThemeColor`:

```ts
import { resolveThemeColor, useTheme } from "@ericsanchezok/synergy-ui/theme"

const theme = useTheme()
const foreground = () => resolveThemeColor(theme.tokens(), "text-base")
```

Keep this read inside Solid reactivity so switching between two themes with the same light/dark mode still updates the renderer. Existing App charts use `useChartTheme()` for series, canvas, axes, grids, legends, tooltips, points, hover, borders, and state colors. Note code blocks use the shared CSS-variable Shiki theme, while Mermaid uses `base` plus resolved `themeVariables` and rerenders through the same theme-change event.

The first-party TUI is a separate non-CSS client and keeps a terminal-appropriate semantic palette in `packages/tui/src/theme.ts`. Its `system`, `light`, and `dark` modes preserve the same surface polarity and color roles, but it does not consume CSS custom properties or plugin-installed themes. `resolveThemeColor` remains the path for imperative renderers hosted inside Web or Desktop.

An isolated consumer that cannot use the Solid context may listen for `THEME_CHANGE_EVENT`. This event fires for both color-scheme changes and same-mode theme changes. Do not infer theme identity only from `data-color-scheme` or a dark-mode media query.

## Choosing Theme Seeds

A theme defines complete `light` and `dark` variants. Each variant supplies nine opaque three- or six-digit hex seeds:

| Seed          | Role                                             |
| ------------- | ------------------------------------------------ |
| `neutral`     | Canvas, surfaces, borders, and ordinary text     |
| `primary`     | Product brand surfaces                           |
| `interactive` | Links, selection, focus, and primary interaction |
| `success`     | Successful or healthy state                      |
| `warning`     | Caution and pending attention                    |
| `error`       | Critical, destructive, or failed state           |
| `info`        | Informational state                              |
| `diffAdd`     | Added diff content                               |
| `diffDelete`  | Deleted diff content                             |

Choose seeds as palette anchors, not as final component colors. The resolver generates the full ramp and semantic contract. Start with seeds only, inspect both modes, and add overrides only for intentional semantic exceptions. Rebuilding most tokens through overrides defeats the shared resolver and makes a theme harder to maintain.

Overrides may use a supported hex value or a reference to another canonical token, for example:

```jsonc
{
  "overrides": {
    "surface-brand-base": "#0E7490",
    "syntax-comment": "var(--text-weaker)",
  },
}
```

References must be canonical and acyclic. Theme loading rejects incomplete variants, translucent seeds, unknown tokens, unsupported syntax, cycles, mismatched manifest/asset IDs, and required text/surface pairs below WCAG AA contrast.

The public contract is available without Solid:

```ts
import { parseTheme, resolveTheme, resolveThemeColor, ThemeSchema } from "@ericsanchezok/synergy-plugin/theme"
```

Plugin Kit `build`, `validate`, and `dev` use this exact parser for both source and packaged Theme JSON. Declared asset hashes participate in the plugin generation, so a Theme JSON-only edit changes the generation URL and invalidates caches. A failed dev rebuild leaves the last valid generation pointer untouched.

## Startup and Desktop Skin

Color scheme and skin identity are separate. `system`, `light`, and `dark` choose the effective variant; the selected namespaced theme ID chooses the resolved colors. The validated `synergy-skin-cache-v1` Web snapshot stores the raw Theme JSON plus flattened light/dark shell colors. The preloader reads only named shell fields after hex validation, while `ThemeProvider` reparses the raw theme before using it.

Desktop persists `DesktopSkinStateV2` with the source, theme ID, and both shell variants. BrowserWindow background, startup overlay, diagnostic page, and temporary window controls use the persisted effective variant before the Web renderer loads. Source-only legacy state migrates to V2 with the generated Synergy fallback. Theme application sends a strict full-skin IPC update; OS appearance changes select a variant without replacing the skin.

## Creating a New Selectable Theme

The recommended path is a structured plugin theme. It uses the public extension boundary, remains independently distributable, and appears in **Settings → General → Appearance** after installation. Do not add a parallel built-in theme registry or theme-specific CSS bundle.

Create the theme plugin from the current template:

```bash
bunx @ericsanchezok/synergy-plugin-kit create ocean-theme --template theme-icon
cd ocean-theme
bun install
```

`theme-icon` is the scaffold name for declarative theme and optional SVG icon assets; it is not a separate theme format. For a theme-only plugin, remove the generated `icon(...)` contribution and SVG file.

Then:

1. Edit the generated `themes/default.json` with complete light and dark seeds.
2. Keep the theme asset `id` identical to the source `theme({ id: ... })` contribution ID.
3. Add overrides only after seed-only visual inspection shows a real semantic exception.
4. Validate, build, and package the plugin:

```bash
synergy-plugin build
synergy-plugin validate
synergy-plugin pack
```

Install or refresh the local project with `synergy plugin add file:///absolute/path/to/ocean-theme`, then switch to it in Appearance. See [Plugin UI contributions](../plugins/ui-contributions.md#themes-and-icons) for the current contribution contract.

### Modifying the built-in Synergy theme

Edit `packages/ui/src/theme/themes/synergy.json` only when changing Synergy's default visual contract. Do not hardcode the adjustment in a consuming component. After the edit, regenerate the theme artifacts and verify the product polarity and contrast in both modes.

### Adding a new semantic token

Add a token only when the product has a durable semantic role that existing tokens cannot represent:

1. Add the name to `packages/plugin/src/theme/tokens.ts`.
2. Assign it in `packages/plugin/src/theme/resolve.ts` for every resolved variant.
3. Regenerate the CSS mappings and JSON schema.
4. Replace consumer-local literals or aliases with the canonical token.
5. Add or update behavioral contract tests and documentation when the role is durable.

Avoid hue-based token names for product semantics. A name such as `surface-critical-weak` remains meaningful across themes; `red-weak` does not.

## Verification

Run the focused contract checks first:

```bash
bun test --cwd packages/ui test/theme.test.ts test/theme-application.test.ts test/theme-generation.test.ts
bun test --cwd packages/app test/testing/color-token-contract.test.ts
bun test --cwd packages/app test/components/note/theme-adapters.test.ts test/components/visualization/use-chart-theme.test.ts
bun test --cwd packages/desktop test/theme.test.ts test/startup-page.test.ts
bun test --cwd packages/plugin-kit test/create.test.ts test/build.test.ts
bun run --cwd packages/ui typecheck
bun run --cwd packages/app typecheck
```

For a platform change, also run:

```bash
bun run --cwd packages/ui test
bun run --cwd packages/app test
bun dev build app
bun run deadcode
bun run quality:quick
```

Inspect light and dark mode, switch between two themes without changing mode, and check DOM surfaces plus Note code/Mermaid, every Chart.js surface, terminal, Monaco, rendered HTML, overlays, status colors, focus, hover, selected, disabled, and error states. Reload Web and fully restart Desktop; neither startup path may show a Synergy fallback frame before the selected custom skin.
