# Decision Record: Size the welcome background independently of the foreground dock

Status: implemented

## Problem

The welcome playfield consumed the measured Composer dock height as bottom padding. Its previous fix sampled a resting stage height and pinned it during explicit expansion, manual resizing and their animations. Natural text growth, attachments and other dock rows still resized the canvas; a cold tall draft established a smaller baseline, and shrinking a window during expanded editing retained stale geometry. On mobile, the dock also reduced the conversation's flex height because it participated in normal flow.

## Decision

The welcome artwork region in `apps/web/src/index.css` uses the conversation pane height minus a stable 12rem design inset. It does not consume the measured dock height. The empty-view scroller has no size-dependent padding: its separate trailing block uses `--prompt-height` to keep the complete artwork and following `session.empty` contributions reachable above the foreground. The native `SessionEmptyView` groups only the artwork inside the fixed-size region; extension content stays in normal flow. The public Composer greeting renderer retains its layout-neutral greeting and contributions, without the native region wrapper. Stable, symmetric scrollbar gutters keep a changing scroll range from changing the artwork width on platforms with non-overlay scrollbars.

New-task docks overlay the welcome at both viewport breakpoints, including through the native `HostView` display-contents wrapper. Ordinary mobile transcripts retain their in-flow dock, and the live dock-height projection continues to own transcript clearance and return-to-latest positioning. That measured border-box already includes mobile safe-area and keyboard space; the scroll tail does not add either again. The sizing rule belongs to the native layout, not arbitrary custom plugin Shells.

`WelcomeStage` has no resting-height signal, resize observer or inline minimum-height writes. CSS supplies its minimum size and its pane supplies its available size, including on cold mount and viewport changes. The existing Composer attribute observer owns only suspension and fading during expanded or manually sized editing and its transitions. Ordinary typing keeps visible gameplay running; changing the size policy does not change game-clock policy.

This supersedes the [archived resting-height pin](../../archived/bug-fix/2026-10-22-keep-welcome-playfield-at-resting-size-under-covering-composer.md). No public plugin layout service, editor sizing rule or Canvas coordinate transform changes.

## Alternatives considered

**Detect more reasons to pin the resting height.** This retains timing-sensitive baseline sampling, requires separate cold-mount and viewport invalidation rules, and couples geometry to unrelated editor states.

**Freeze the shared dock-height projection.** Conversation clearance and floating controls need the current full border-box height; freezing that value makes foreground controls cover other content.

**Use the whole pane without compact-entry clearance.** This preserves scale but places the bottom of a normally playable board behind even an empty Composer. The stable design inset keeps compact entry usable, and short windows can scroll the welcome independently.

**Change Canvas scaling or cap Composer growth.** These change game input mapping or editor behavior while leaving the wrong layout dependency in place.

## Consequences

Foreground growth covers rather than resizes or repositions the playfield, regardless of the draft's initial contents. Window and pane geometry still resize it. Taller task-entry content can obscure the board; scrolling can expose it above the dock, and reducing that content reveals the same scene without a resize-induced bitmap allocation. The fixed inset is intentional spacing, not a claim that every dock fits within it.

The stage browser suite composes the real `DefaultSession`, `HostView`, `ConversationPresentation`, `SessionEmptyView` and `PromptDock` with its `DefaultComposer`, replacing its fixed-height mock Composer. The empty-view grouping is the production component, not a copy of its DOM. It checks natural growth and removal, attachment and pending-row changes, cold long drafts, expanded viewport shrinkage, manual resizing and expansion, plus short mobile scrolling, extension hit targets, plain greetings, breakpoint changes and return to transcript flow. Bounds and backing bitmap dimensions establish geometry independently from the retained pause and fade checks.
