# Decision Record: Keep the mobile inbox trigger out of a reserved band above the composer

Status: implemented

## Problem

On mobile session views, the inbox trigger row sat in a full-width band above the composer that read as a solid black strip hiding the last messages. Runtime geometry in a 390 px viewport showed why:

- `PromptDock` became a normal-flow flex item on mobile (commit 20d96f9d4) so the composer stays above the on-screen keyboard, but it kept the `pt-12` (48 px) top padding the dock needed only while it was a desktop-style overlay.
- The inbox trigger is absolutely positioned inside that padding band (`top: -2.875rem`), occupying only the right ~36 px. The remaining full-width 48 px strip had no content and showed the raw page surface (`--background-stronger`), which in the dark theme is near-black.
- The message scroller sat directly above the dock with only `pb-4` (16 px) content padding, so the last message visually ended right at the edge of the empty band — the band looked like it was covering the conversation.

## Decision

Scope the reserved dock padding to desktop only and let the trigger ride the composer on mobile:

- `PromptDock` applies `md:pt-12` instead of `pt-12`, so the mobile dock contributes no empty band above the composer. Desktop (>= 48rem) keeps the overlay dock and its 48 px padding unchanged.
- The mobile inbox anchor moves from the middle of the former band to the composer's top-right edge (`top: -1rem`): the 36 px trigger now hugs the shell, with its lower 20 px overlapping the composer's top border area rather than floating over message content.
- The conversation content bottom padding grows from `pb-4` to `pb-6` (16 px -> 24 px) on mobile so the last full-width message clears the floating trigger.
- `PromptDockFloatLayer` (progress island, subagent rows, workflow offers) keeps its absolute `bottom-full` overlay only at >= 48rem (`md:absolute md:inset-x-0 md:bottom-full`). Below 48rem the wrapper joins the dock's normal flow (`relative w-full`), so active controls reserve exactly their own height above the composer — instead of overlaying the last message — and idle controls collapse to zero height, so no fixed band returns.

The >= 48rem media-query placement (vertically centered, outboard right of the composer) is unchanged.

## Alternatives considered

**Keep the 48 px band but give it a surface color.** Rejected: the band existed only to reserve room for a dock overlay that mobile no longer uses; painting it would leave a dead strip between the last message and the composer on every mobile session.

**Move the inbox trigger into the status bar below the composer.** Rejected: it changes the reachability and discoverability of the queue surface on mobile and duplicates the desktop anchoring logic; the trigger is intentionally adjacent to the composer where queued work becomes visible.

**Only change the conversation bottom padding.** Rejected: it would space the messages further from the black band without removing the band itself, which is the visual defect.

**Preserve a fixed mobile clearance for the still-absolutely-positioned float layer.** Rejected: the float layer's height varies from a ~40 px collapsed island to taller subagent rows, so any fixed gap is either too small (controls still overlap the last message) or recreates an empty strip when idle. Flowing the layer on mobile reserves exactly the space its visible controls occupy.

## Consequences

- Mobile sessions no longer show an empty near-black strip between the conversation and the composer; the message scroller gains the full 48 px it lost to the padding, and the last message keeps clear of the floating trigger.
- The inbox trigger sits partially over the composer's top-right edge on mobile, matching the floating-control language already used for progress islands; the popover and desktop anchoring behavior are untouched.
- Two regression nets pin the layout: the standalone Chromium suite (`session-inbox-anchor-layout.test.ts`, registered in `script/test.ts`'s `playwrightIsolated`) derives the dock band and conversation clearance classes from the component sources and measures trigger geometry at both breakpoints; the production-build contract test (`app-build-css-contract.test.ts`) rebuilds the app and asserts the emitted classes resolve to the intended geometry — desktop keeps the 48 px band with an absolute float overlay, mobile collapses the band and flows the float layer (a busy control pushes the composer down; idle collapses to zero). Reverting `md:pt-12`, `pb-6`, or the float-layer class change fails the suites.
