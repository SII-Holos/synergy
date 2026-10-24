# Decision Record: Chinese glyphs in Linux browser fixtures

Status: implemented

## Problem

Localized pixel and geometry assertions depend on the fonts actually painting their text. A browser can resolve `document.fonts.ready` while its selected system font lacks Chinese glyphs. Missing-glyph boxes do not exercise the intended labels and can make a valid intensity threshold impossible to reach.

## Decision

Linux execution units declaring browser prerequisites install `fonts-wqy-zenhei` through the shared CI setup action. The package is part of the pinned Playwright system dependency list, cited beside the installation. Hosted browser libraries remain reused; other platforms and execution units do not receive the extra package.

The existing active-status sweep retains its colors, timing, travel and minimum painted intensity range. A native Linux Chromium 156 comparison of the same production fixture reproduced a 74-level Chinese light-mode sweep with DejaVu Sans missing-glyph fallback; even static endpoint colors reached only 76. With WenQuanYi Zen Hei, the unchanged sweep reaches 97 in light mode and 94 in dark mode. English remains 100 and 98. Chromium's platform-font report distinguishes the actual Chinese font from the fallback, independently of font-loading readiness.

## Alternatives considered

**Lower the intensity threshold or ignore Chinese.** This would accept weaker motion and stop checking the localized text that the test claims to cover.

**Change the product gradient or font weight.** A wider peak still cannot exceed the fallback glyph's static endpoint range. Product styling should not compensate for missing test-environment glyphs.

**Reinstall every Playwright system dependency.** The hosted image already supplies the browser libraries. One declared font repairs the missing prerequisite without repeating unrelated library installation.

## Consequences

Linux browser setup adds one font download and installation. Real Chinese glyphs can change measured line widths, which is intended coverage rather than a reason to preserve missing-glyph geometry. Existing pixel, movement, accessibility and layout assertions remain in force. A local Linux comparison establishes the prerequisite's effect; the current commit still requires complete CI and independent review before merge.
