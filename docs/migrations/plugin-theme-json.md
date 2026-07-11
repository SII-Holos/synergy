# Plugin Theme JSON Migration

Plugin theme contributions use validated structured JSON rather than theme CSS.

For each manifest theme entry:

1. Keep its `id` and `label`.
2. Change `path` from the CSS asset to a packaged `.json` file.
3. Define `name`, `id`, and complete `light.seeds` and `dark.seeds` objects with `neutral`, `primary`, `success`, `warning`, `error`, `info`, `interactive`, `diffAdd`, and `diffDelete` colors. Seed values must be opaque three- or six-digit hex colors, and the asset `id` must match the manifest entry.
4. Move intentional semantic exceptions into each variant's `overrides` object using canonical theme token names.
5. Remove global selectors and component-specific overrides from the theme contribution. A theme changes the shared color system; plugin component styling remains owned by the component bundle.
6. Rebuild with the current plugin kit, then run `synergy-plugin validate`, `synergy-plugin build`, and `synergy-plugin pack`.

The host resolves both variants before registration and rejects CSS theme paths, mismatched IDs, unknown override keys, incomplete or translucent seeds, unsupported color syntax, cyclic token references, and required text/surface pairs below WCAG AA contrast. See [Plugin UI contributions](../plugins/ui-contributions.md#commands-themes-and-icons) for the current manifest and asset examples.
