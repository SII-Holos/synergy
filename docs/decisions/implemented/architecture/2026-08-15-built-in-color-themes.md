# Decision Record: Built-in color themes through a single shared registry

Status: implemented

## Problem

Synergy shipped one curated default theme with roughly 180 hand-tuned overrides, and selectable themes were only reachable through plugins. Users asked for an out-of-the-box set of curated color skins (Catppuccin, Tokyo Night, Ayu, Rose Pine, Kanagawa, Everforest, Solarized), which forced a decision: either extend the core with a parallel built-in theme path, or fit the new skins into the existing shared resolver/registry contract.

## Decision

Add seven built-in color skins alongside the Synergy default, all resolved through the existing single theme registry and shared resolver pipeline:

- The registry (`packages/ui/src/theme/plugin-theme-registry.ts`) pre-registers built-in skins at module load; plugin themes register into the same table. There is no parallel built-in lookup path, and a plugin theme may not shadow a built-in skin id.
- The seven new skins are **seeds-only** (thirteen seeds, zero overrides): the shared resolver generates the full token ramp and the WCAG-AA contrast assertions guarantee quality.
- The **Synergy default keeps its curated overrides** in `themes/synergy.json` because it is the shipped product contract; restoring it as seeds-only changed the shipped look (flat light canvas, sub-AA markdown and startup-control colors).
- The public seed contract stays backward compatible: `THEME_SEED_NAMES` and `ThemeSeedName` remain the original nine names, the four syntax seeds are optional in author input, and `resolveThemeVariant` normalizes missing syntax seeds at its boundary so legacy nine-seed themes keep resolving without `parseTheme`.

## Alternatives considered

- **A parallel built-in theme registry** — rejected: it would create two production paths for the same Theme object (plugin validation vs core code), a second id namespace with implicit priority rules, and a maintenance surface that duplicates the shared resolver.
- **All built-in skins seeds-only, including Synergy** — rejected: the seeds-only resolver produced a visibly different default (light surfaces darker than the canvas, `text-weak` collapsing onto `text-base`, markdown headings at ~2.5:1), changing the shipped product contract without a product decision.
- **Shipping the seven skins as an official theme plugin** — rejected for the default experience: the product wanted the curated set available out of the box, without an install step; the skins remain technically expressible as plugins, which stays the recommended path for third-party themes.

## Consequences

- Every built-in skin now carries the same machine-guaranteed contrast and token completeness as plugin themes, verified by the shared `assertThemeContrast` gate.
- The Synergy default carries an override maintenance cost (the curated ~180-token contract) that the other built-ins avoid; this is the accepted price of preserving the shipped visual contract.
- Seed type compatibility is preserved for API4 consumers (`ThemeSeedName` stays nine names; the expanded union lives behind `ThemeAllSeedName`), while the resolver accepts both nine- and thirteen-seed themes.
- Keyboard and behavioral coverage for the new Appearance picker moved to a Playwright fixture, since bun's test transform cannot render Solid TSX directly.
