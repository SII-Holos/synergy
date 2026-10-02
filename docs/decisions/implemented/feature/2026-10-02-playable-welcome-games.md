# Decision Record: Use immersive pixel games in task introductions

Status: implemented

## Problem

A narrow framed demonstration with separate branding, instructions and action rows fragments the welcome page. A static idle state does not communicate that it can be played. Onboarding should provide immediate feedback while leaving the ordinary task composer available.

## Decision

Four independently loaded local games provide timed stacking, pixel slingshot, falling blocks and aircraft combat. Independent deterministic models and a slingshot physics controller own their rules, collision checks, success/failure transitions and bounded collections. Falling blocks use seeded seven-piece bags, wall-aware rotation, a landing preview and row clearing. Aircraft combat has three enemy routes and durability levels, bounded density and speed, automatic fire, guaranteed cyclic pickups, and timed firepower and shields. Repair caps health and converts surplus to score. Leaks only break combos; collision immunity prevents repeated damage. Local hit, explosion and pickup feedback replaces rapid flashing. Steering and effect clocks run inside fixed steps, so render rate does not alter rules. Stacking captures horizontal placement before its landing animation, uses contiguous 16-pixel floors, and rewards aligned placements. It continues through twelve-floor milestones with a following camera and only the latest 24 floors retained. A shared bounded 120 Hz timestep retains fractional frame time; pausing does not accumulate wall-clock debt. Slingshot uses Matter.js 0.20.0 behind its lazy module, without the library renderer or runner. Six authored structures support three shots per attempt, indirect impacts, breakable wood, movable stone, stars and cumulative challenges. Ballistic preview shares the gravity and timestep and stops at the first collision. Settlement gates results; cancelled drags never spend ammunition. Plain snapshots restore body positions, velocities, level and score; disposal releases the world and collision listeners. Dynamic bodies are bounded by the authored structures plus three projectiles (under 48), with at most 24 visual bursts.

The welcome occupies the full chat width. A separately mounted, non-interactive pixel background covers the chat pane, including the composer surroundings. Seeded columns move at different speeds with gentle lateral drift and opacity waves; edge fading hides wraparound. The playfield has no visible enclosure. A headline, short sentence and one focusable game status control are the entire welcome chrome. The status control handles start, pause, resume and retry. Ordinary project and attachment entry points stay in the composer. Removed game modules, task-starter code, tests and catalog entries are deleted together.

A logical-resolution Canvas buffer and nearest-neighbor scaling preserve pixel silhouettes. Sprites, material textures and building details are locally authored. Shared drawing primitives handle scaling and canonical theme colors; each module owns gameplay and rendering. Theme changes repaint without resetting progress. There is no external asset request, sound, shared game engine or new Plugin API.

Idle stacking moves before the first drop. Slingshot aiming, falling-block placement and aircraft steering respond to pointer movement before play. Clicks, touch gestures and local keyboard actions start gameplay. Clicking elsewhere, typing, Escape, obscuring overlays, hidden pages, offscreen artwork and expanded editing pause clocks without clearing state. Keyboard focus uses a small status underline rather than a playfield outline. Reduced motion removes decorative loops and waits for a deliberate play action. The focusable status control keeps continuous motion pauseable without a separate toolbar; see [WCAG 2.2.2](https://www.w3.org/WAI/WCAG22/Understanding/pause-stop-hide.html).

The games use established timing, falling-block, aiming and scrolling-shooter interaction families, with original code and artwork. The alignment-and-height reference is [Stack by KCHLAB](https://www.kchlab.com/). No source code or assets are incorporated from that reference. Rigid-body integration follows the [Matter.js Engine API](https://brm.io/matter-js/docs/classes/Engine.html); the pinned MIT dependency remains isolated to slingshot. Selection and local state ownership follow [interactive task introductions](2026-10-02-interactive-task-welcome.md).

## Alternatives considered

**Separate game cards and persistent toolbars.** They reduce the playfield and add controls before the first meaningful interaction.

**A universal game engine.** Game-specific models keep simple rules local. Only slingshot needs a rigid-body solver for rotation and contact between structures; it is independently loaded and never enters the default chat startup graph.

**A full 3D environment.** A small pixel vocabulary keeps loading and rendering costs bounded while canonical theme tokens maintain readable silhouettes.

## Consequences

Behavioral tests cover collision, row clearing, support loss, reachable destinations, idle feedback and restart. Browser tests cover pane geometry, draft independence, pause/resume, pointer cancellation, keyboard/touch, themes, narrow panes and reduced motion. Games are local examples; they never generate messages, replace drafts or access user files.
