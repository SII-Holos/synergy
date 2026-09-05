# PR 13 — Session header safe inset

## Intent

Keep the first conversation content below the real desktop session header instead of relying on a smaller guessed inset.

## Changes

- Restore the desktop conversation top padding and scroll padding to `58px`, matching `.stb-root` desktop height.
- Preserve the mobile `48px` top-bar behavior because the utility class remains inside the `md:` breakpoint.
- Keep sticky header rendering, anchor navigation, scroll-to-message behavior, and plugin header slots unchanged.

The preceding PR08 visual claim was too aggressive: the desktop header is still `58px` tall. This follow-up corrects the overlap risk rather than reducing chrome further.

## Review visual

See `assets/pr-13-session-header-safe-inset.svg` for a schematic overlap comparison. It is a hand-authored design review artifact, not a runtime screenshot or browser regression capture.
