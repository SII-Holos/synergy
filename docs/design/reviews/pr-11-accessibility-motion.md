# PR 11 — Accessibility and motion closeout

## Intent

Make the redesigned surfaces dependable for keyboard users, narrow layouts, and people who request reduced motion.

## Changes

- Add consistent `:focus-visible` rings to marketplace search, refresh, source filters, navigation controls, and the settings close action.
- Disable non-essential transitions in both surfaces under `prefers-reduced-motion: reduce`.
- Keep loading indicators and progress semantics intact while removing only decorative movement.
- Preserve mobile breakpoints, touch target sizing, localization, and existing dialog focus behavior.

## Review visual

See `assets/pr-11-accessibility-motion.svg` for a schematic focus-state comparison. It is a hand-authored design review artifact, not a runtime screenshot or browser regression capture.
