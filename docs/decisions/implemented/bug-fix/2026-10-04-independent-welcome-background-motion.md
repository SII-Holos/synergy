# Decision Record: Keep welcome background motion independent of game pause

Status: implemented

## Problem

The welcome background covers the entire chat pane, but its clock uses the game's interaction gate. Pausing through the status control or Escape, typing, opening a dialog, expanding the composer or scrolling the game out of view freezes that background. A natural game ending leaves it moving, so the same page appears inconsistent depending on how play stops.

## Decision

The welcome host supplies document visibility directly to the ambient field and retains the complete interaction gate as `gameActive` for the selected game. The ambient field combines document visibility with the reactive reduced-motion preference. Its existing bounded frame clock freezes in place when either condition disallows animation, resumes without paused wall-clock debt and is disposed with the component.

Game status, editing, dialogs, composer expansion and game artwork intersection affect only the game clock. Ending and replay presentation continue to follow that clock. Ambient rendering keeps its existing seeded motifs, theme tokens, pane placement and input-transparent Canvas.

The motion gating facts in [interactive task introductions](../feature/2026-10-02-interactive-task-welcome.md) and [playable welcome games](../feature/2026-10-02-playable-welcome-games.md) reflect these separate lifetimes; their selection, model and rendering decisions remain applicable.

## Alternatives considered

**Keep the shared game gate.** It makes page decoration depend on game-specific interactions and produces different background behavior for manual pause and natural completion.

**Run the background unconditionally.** It would ignore the reduced-motion preference and spend work while the page is hidden. The existing visibility-aware frame clock already handles suspension and cleanup.

## Consequences

The background remains animated during visible-page task editing and game pauses, increasing decorative rendering time in those states. Hidden pages and reduced motion still suspend it. Browser regressions compare real Canvas frames to verify background movement alongside frozen gameplay, independent resumption after visibility and preference changes, draft preservation and teardown.
