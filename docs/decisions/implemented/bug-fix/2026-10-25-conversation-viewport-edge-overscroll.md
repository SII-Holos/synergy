# Decision Record: Suppress edge overscroll on the conversation viewport

Status: implemented

## Problem

The outer conversation viewport could expose the browser's vertical edge-overscroll effect after the reader reached the transcript boundary. In the Desktop conversation surface this appeared as the whole transcript briefly pulling away from the bottom and settling back. The outer viewport already disables native scroll anchoring and owns reading-position compensation, so changing its scroll position in JavaScript would compete with that logic and would not remove a platform overscroll effect.

## Decision

The production outer conversation viewport uses `overscroll-behavior-y: none`. The rule is scoped to `[data-conversation-viewport]`, so it prevents the transcript boundary from producing or chaining the vertical overscroll effect without changing the page-wide scroll policy. The nested `ProcessViewport` keeps its existing `overscroll-behavior: contain` behavior because its local boundary is an intentional independent reading region.

The real `ConversationViewport` browser fixture asserts the computed outer rule while retaining its existing inner-process, latest-button, activity-resize, narrow-layout and pending-decision coverage.

## Alternatives considered

**Use `overscroll-behavior-y: contain` on the outer viewport.** Rejected: it prevents scroll chaining but preserves the boundary affordance that is visible as the pull-and-settle motion.

**Clamp or reset `scrollTop` from the scroll handler.** Rejected: the handler runs after native movement and cannot reliably cancel the compositor's edge effect; it would also interfere with the existing reading-anchor and virtual-layout compensation in `createAutoScroll`.

**Disable overscroll on the document or workbench shell.** Rejected: the symptom belongs to the transcript owner, and a global rule would change unrelated panels and dialogs.

## Consequences

Reaching either vertical edge of the transcript no longer produces the outer viewport's native pull-and-settle effect or chains that gesture into an ancestor. Inner process scrolling remains independently contained. The focused browser test verifies the shipped CSS contract and existing interaction behavior, but headless Chromium cannot provide visual evidence for macOS Desktop rubber-band rendering; final platform confirmation remains a Desktop/manual check.
