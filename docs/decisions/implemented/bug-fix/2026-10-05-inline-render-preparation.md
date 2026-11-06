# Decision Record: Inline Render preparation

Status: implemented

## Problem

A Render result belongs in the conversation, but its presentation also needs to be coherent while the model streams its arguments and the tool runs. A completed-only figure makes active calls show generic execution chrome before changing into a visual. Previewing unfinished HTML would instead expose unstable input as a completed result.

## Decision

[RenderTool](../../../../packages/ui/src/components/render-tool.tsx) owns an accessible inline preparation body for pending, generating and running states. The figure and quiet caption remain mounted through the completed HTML receipt; only that receipt mounts the sanitized visual and its expand action. Parsed argument fragments may update the caption but never become iframe content. The shared Spinner is decorative, and reduced motion disables its animation.

This replaces only the generic active-state presentation selected in [Content-first inline Render visuals](../feature/2026-10-04-inline-render-visuals.md). That record remains active because its static isolation, natural sizing, canonical ordering and viewer decisions still apply. Error receipts keep the existing activity detail and recorded diagnostic; completed receipts without HTML keep the inline generic disclosure and selectable output, rather than retain the preparation figure indefinitely. There are no backend, SDK or persistence changes.

## Alternatives considered

**Keep generic active lifecycle chrome.** This is the completed-only implementation being corrected: it makes the streaming presentation inconsistent with the intended inline visual and reveals unrelated tool disclosure before content arrives.

**Preview partial argument HTML.** Even a parsed complete HTML argument is not a completed tool receipt. Rendering it while generation or execution is active would introduce unstable documents and premature expansion, so the completed metadata remains authoritative.

## Consequences

Active Render calls have a consistent inline presentation without exposing incomplete markup. The loading body consumes a small fixed minimum region; caption changes can still follow the existing partial-argument parsing cadence. Failed receipts return to activity details, while completed receipts without HTML return to the inline output disclosure, instead of promising a visual that cannot be displayed.

[Chromium coverage](../../../../packages/ui/test/components/render-html.browser.test.ts) drives the real SessionTurn through every active state and completion, checks retained figure identity, incomplete-content isolation, readable terminal evidence, narrow loading layout and reduced motion. The [frontend workflow](../../../../.synergy/skill/develop-frontend/SKILL.md) requires testing the actual error/result presentation rather than assuming every failure produces an inline error card.
