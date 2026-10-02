# Decision Record: Use immersive pixel games in task introductions

Status: implemented

## Problem

A narrow framed demonstration with separate branding, instructions and action rows fragments the welcome page. A static idle state does not communicate that it can be played. Onboarding should provide immediate feedback while leaving the ordinary task composer available.

## Decision

Four independently loaded local games provide timed stacking, gravity-assisted delivery, falling blocks and aircraft combat. Pure deterministic models own their rules, collision checks, success/failure transitions and bounded collections. Falling blocks use seeded seven-piece bags, wall-aware rotation, a landing preview and row clearing. Aircraft combat has steering, automatic fire, bounded enemies and particles, collision immunity and restart. Stacking preserves overlapping support and rewards aligned placements. Gravity delivery integrates at a fixed timestep shared by trajectory preview and actual flight.

The welcome occupies the full chat width. A separately mounted, non-interactive pixel background covers the chat pane, including the composer surroundings. Seeded columns move at different speeds with gentle lateral drift and opacity waves; edge fading hides wraparound. The playfield has no visible enclosure. A headline, short sentence and one focusable game status control are the entire welcome chrome. The status control handles start, pause, resume and retry. Ordinary project and attachment entry points stay in the composer. Removed game modules, task-starter code, tests and catalog entries are deleted together.

A logical-resolution Canvas buffer and nearest-neighbor scaling preserve pixel silhouettes. Sprites, planet textures and building details are locally authored. Shared drawing primitives handle scaling and canonical theme colors; each module owns gameplay and rendering. Theme changes repaint without resetting progress. There is no external asset request, sound, general game engine or new Plugin API.

Idle stacking moves before the first drop. Gravity aiming and aircraft steering respond to pointer movement before play. Clicks, touch gestures and local keyboard actions start gameplay. Clicking elsewhere, typing, Escape, obscuring overlays, hidden pages, offscreen artwork and expanded editing pause clocks without clearing state. Keyboard focus uses a small status underline rather than a playfield outline. Reduced motion removes decorative loops and waits for a deliberate play action. The focusable status control keeps continuous motion pauseable without a separate toolbar; see [WCAG 2.2.2](https://www.w3.org/WAI/WCAG22/Understanding/pause-stop-hide.html).

The games use established timing, falling-block, aiming and scrolling-shooter interaction families, with original code and artwork. The alignment-and-height reference is [Stack by KCHLAB](https://www.kchlab.com/). No source code or assets are incorporated from that reference. Selection and local state ownership follow [interactive task introductions](2026-10-02-interactive-task-welcome.md).

## Alternatives considered

**Separate game cards and persistent toolbars.** They reduce the playfield and add controls before the first meaningful interaction.

**A universal game engine.** These small simulations need no shared rules interpreter or external runtime.

**A full 3D environment.** A small pixel vocabulary keeps loading and rendering costs bounded while canonical theme tokens maintain readable silhouettes.

## Consequences

Behavioral tests cover collision, row clearing, support loss, reachable destinations, idle feedback and restart. Browser tests cover pane geometry, draft independence, pause/resume, pointer cancellation, keyboard/touch, themes, narrow panes and reduced motion. Games are local examples; they never generate messages, replace drafts or access user files.
