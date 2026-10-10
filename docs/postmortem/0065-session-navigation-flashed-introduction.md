# Session navigation flashed the introduction and overlapped transcripts

## Executive summary

Opening an existing Home Session could display the retired new-task greeting while history loaded. Once ready, the incoming transcript faded in above an opaque outgoing copy, blending unrelated text. End-state assertions missed both transient states. New-task identity and one-visible-transcript admission now have browser regressions.

## Summary

The empty-bucket predicate conflated a missing history snapshot with a new task. It also classified confirmed empty Home Sessions as new. That predicate controlled both the page branch and presentation readiness, so it could release the previous picture before the target conversation was ready. The fallback used separate obsolete branding and copy instead of the game's current heading.

## Timeline

- The navigation report identified a brief introduction and overlapping message streams.
- A real-host test held a Home Session's first history response pending and observed the introduction.
- A browser component test sampled incoming admission and found the old transcript still retained while the incoming text was partially transparent.
- The same regressions passed after identity-based greeting selection and atomic presentation admission.

## Root cause

The route's Session identity was available but message count determined new-task intent. Presentation then treated two painted layers as a harmless fade even though their transparent descendants contained different text. Existing tests verified retained loading, final content and reduced motion; none inspected the admission frame. The games-disabled test explicitly expected the retired heading.

## Guardrails added

- [Production conversation tests](../../test/plugin-ui5/messages-browser.test.ts) hold history pending and separately exercise confirmed empty Home Sessions.
- [Presentation tests](../../apps/web/test/components/session/conversation-presentation.dom.test.ts) require one opaque transcript at admission and cover immediate replacement, stale completion, Scope changes and reduced motion.
- [Welcome tests](../../apps/web/test/components/session/new-view.dom.test.ts) require the shared current heading and retain keyboard, narrow-layout and game-toggle coverage.
- [Frontend guidance](../../.synergy/skill/develop-frontend/references/conversation.md#conversation-navigation-motion) requires intermediate-frame checks without machine-dependent latency assertions.

## Lessons

Loading and emptiness are data states; neither establishes new-task intent. A transition that finishes correctly can still expose incorrect content between endpoints. The [navigation presentation decision](../decisions/implemented/bug-fix/2026-10-10-session-navigation-presentation.md) keeps visual retention separate from data ownership and releases the old picture before exposing its replacement.
