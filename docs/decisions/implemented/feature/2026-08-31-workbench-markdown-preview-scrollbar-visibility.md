# Decision Record: Workbench Markdown Preview Scrollbar Visibility

Status: implemented

## Problem

The file-workbench and attachment-workbench Markdown preview scroll containers inherited only the global scrollbar baseline. That baseline tints the thumb with `--border-weaker-base`, which resolves to roughly 6% opacity in light mode and 5% in dark mode, leaving the thumb effectively invisible on the light preview surface. Users scrolling a long rendered document had no affordance for how far they had read or how much remained. The scrollbar is also not an overlay: at 14px webkit width it consumed layout width without compensating gutter, so making it visible could otherwise shift content when overflowing.

## Decision

Strengthen the scrollbar treatment locally on the two Markdown preview scroll containers instead of changing the global baseline.

- `.file-markdown-preview` (file workbench) and `.attachment-workbench-viewer` (attachment workbench) now set `scrollbar-color: color-mix(in srgb, var(--text-strong) 24%, transparent) transparent` and `scrollbar-gutter: stable`.
- Their `::-webkit-scrollbar-thumb` now uses `background-color: color-mix(in srgb, var(--text-strong) 24%, transparent)` with `::-webkit-scrollbar-thumb:hover` using `color-mix(in srgb, var(--text-strong) 34%, transparent)`.

Tinting from `--text-strong` (the foreground text color) instead of a fixed border step keeps the thumb at the same relative contrast in both modes — roughly 24% of near-black in light mode and 24% of near-white in dark mode — where the fixed `border-strong-base` step collapsed to 14% opacity in dark mode and remained too faint there.

`scrollbar-gutter: stable` reserves the gutter so the newly visible 14px webkit scrollbar does not resize the readable column when content toggles between overflowing and not. Only the preview surfaces are affected; the global `* { scrollbar-color: var(--border-weaker-base) transparent }` baseline and the shared `::-webkit-scrollbar-thumb` styling in `packages/ui/src/styles/utilities.css` are left unchanged.

## Alternatives considered

- **Raise the global scrollbar baseline (`packages/ui/src/styles/utilities.css`).** Rejected for this fix: the same near-invisible thumb is deliberate in dense session surfaces that layer their own treatment, and strengthening it everywhere risks regressing chat and list surfaces that rely on a quiet scrollbar.
- **Use a fixed border step for the thumb.** Rejected: no single step reads in both modes — `border-weak-base` (10% light / 8% dark) and even `border-strong-base` (20% light / 14% dark) stay too faint in dark mode, where the user reported the problem. Relative `text-strong` mixing is the only single-rule option that holds contrast across modes.
- **Leave the change unrecorded as a purely local tweak.** Rejected: it alters a user-facing presentation contract in the workbench preview, which a maintainer could reasonably revisit, so it warrants a record.

## Consequences

- Bought: the Markdown preview scrollbar is now visible and gives a position/extent cue while scrolling long documents, in both color modes, without content relayout when the scrollbar appears.
- Cost: two preview containers now carry their own scrollbar thumb rules, so any future global scrollbar redesign must remember to sweep scoped overrides; `scrollbar-gutter: stable` permanently reserves the gutter on these containers even when content fits.
