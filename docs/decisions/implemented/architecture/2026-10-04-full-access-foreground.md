# Decision Record: Full Access selector foreground

Status: implemented

## Problem

Full Access needs a distinct warm foreground in the default permission selector without recoloring unrelated warnings. Using the general warning foreground for both roles couples a focused selector adjustment to warning presentation throughout the product.

## Decision

Use the independent public canonical token `text-permission-full-access`, owned by `packages/plugin/src/theme/`, for the selector's Full Access foreground. The [theme reference](../../../reference/frontend-theming.md#full-access-selector-foreground) owns the default light/dark values and fallback semantics; `packages/ui/src/theme/themes/synergy.json` owns the default skin overrides.

The Full Access entry in `apps/web/src/components/prompt-input/permission-modes.ts` uses `text-text-permission-full-access` as its `iconClass`. `permission-selector.tsx` already shares that class across the trigger icon, trigger short label and menu icons. Keep the existing `permission.fullAccess` shield glyph and selector layout, Guarded's green and Autonomous's blue roles, and unrelated warning colors. The [Web product contract](../../../../apps/web/PRODUCT.md) owns this durable visual rule. Permission enforcement is unchanged.

The Full Access trigger alone uses a subtle interaction fill mixed from the active `input-base` and `text-strong` roles. The ordinary toolbar hover and open fills reduce the approved light foreground below AA text contrast after transitions settle. Keep a visible darker-in-light / brighter-in-dark interaction surface without changing the foreground, geometry, focus outline or other toolbar modes. Verify resting, settled-hover and open-trigger text contrast plus menu-icon contrast in the rendered selector.

## Alternatives considered

**Recolor the global warning foreground or seed.** Rejected because it changes unrelated warning text, icons or surfaces. The requested distinction belongs to the Full Access selector, not every caution or pending-attention state.

**Use a local literal hue or component-local light/dark palette.** Rejected because it bypasses the shared theme resolver, prevents consistent theme overrides and duplicates color ownership in product code.

**Use an independent semantic token.** Chosen because the default skin can distinguish Full Access without changing warning roles, while themes without an explicit override retain their warning foreground through the resolver fallback.

## Consequences

Existing input Theme JSON, including seed-only built-in and plugin themes, remains compatible without edits or migration. The resolver supplies the new role and its fallback; theme authors can intentionally override it through the public theme format.

Compatibility is directional: a Theme JSON override naming the new token requires both a host and Plugin Kit version whose canonical token set recognizes it. Older strict parsers reject that override as unknown; accepting older theme input does not imply that older consumers accept new token names.

TypeScript consumers that construct complete `ResolvedTheme` maps, maintain exhaustive `Record<ThemeTokenName, …>` mappings or switch over every token must handle the added member. Prefer the public resolver for complete output; a handwritten resolved map can add the warning reference fallback. This source update is distinct from input data migration.

This adds one maintained semantic role and its generated outputs, but avoids global warning scope leakage and component-local color logic. It does not introduce stricter global contrast gates or expand the resolver's required-pair list. Existing validation remains in force, and source values alone do not establish rendered selector contrast or visual acceptance.
