# Decision Record: Airy composer surface — white fill, interactive focus border, lighter elevation

Status: implemented

## Problem

The composer read as the heaviest element of the workbench: an inset gray fill on a hairline card, a focus state that only deepened the gray border, a single top-highlight shadow, 32px toolbar controls, and a 36px square-radius submit button. Adjacent dock surfaces (the status pill) sat 4px below the editor, so the whole dock area visually collapsed into one dense block.

## Decision

Restyle the composer as the one intentionally floating surface of the prompt dock, keeping its existing DOM and behavior contracts (toolbar controls, attachment flows, submit/stop semantics) untouched.

- The shell becomes a raised white surface (`surface-raised-base`) with a resting border one step stronger than card hairlines (`border-strong-base`) and a two-layer elevation tuned to roughly 4%/7% effective overlay alpha — light enough to feel attached to the canvas, present enough to justify being the only floating element. Shadow color is derived by diluting `--surface-overlay` via `color-mix` so both themes get calibrated values without new tokens.
- Focus becomes semantic: `:focus-within` swaps the border to the interactive blue (`border-interactive-base`) so the active input is identifiable at a glance, matching the product rule that blue marks interaction and live execution.
- The submit button shrinks to a 34px circle while keeping the `primary` variant (black resting fill, white icon); the running state keeps the black stop affordance — blue was evaluated for the resting fill and reverted as too loud against the neutral dock.
- Toolbar controls drop to 28px borderless chips (8px radius, transparent fill, hover fill via the existing workbench hover mapping), and editor padding aligns to the tighter 4px-based rhythm.
- The status pill's top spacing widens from 4px to 12px so the two dock surfaces read as separate layers.
- Mobile keeps a flat variant: hairline border, no elevation.

## Alternatives considered

**A full Airy token/theme pass** (flattened elevation tiers, warm neutrals, opacity-only motion, restyled status bar and top bar) was prototyped end-to-end in this task and reverted by user decision; only the composer slice and the dock spacing survived review. The backup diff was retained during evaluation and discarded after.

**Blue submit fill** was tried against the neutral dock and reverted the same session — it competed with the focus border and broke the black-send/black-stop symmetry.

**Ghost (borderless) submit** was rejected in review for weak discoverability in the resting state on the white shell.

## Consequences

- The composer is visually distinct as the dock's single floating surface; everything else in the dock stays grounded.
- No DOM or behavior change: toolbar contracts (agent/permission/workflow/add), attachment flows, submit/stop semantics, and reduced-motion behavior are exactly as before.
- Elevation values live in the app-layer composer block and dilute the shared overlay token, so theme changes recalibrate automatically.
