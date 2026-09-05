# PR 04 — Shared state language

## Intent

Make operational state readable without turning every row into a colored card. The hierarchy is now: neutral by default, blue for active work, amber for attention, and red only for failure.
## Changes

- Activity status labels use icon-level semantic color rather than a filled critical treatment.
- Running tool spinners use the existing info semantic token.
- Waiting-for-approval activity receipts gain a restrained amber leading rule.
- Failed activity receipts gain a restrained critical leading rule.
- Completed states remain quiet and inherit the surrounding text color.

## Review visual

See `assets/pr-04-state-language.svg` for the before/after state strip.

## Scope

This PR only changes shared `activity-trace` and `basic-tool` state presentation. It does not change state computation, copy, localization, or lifecycle behavior.