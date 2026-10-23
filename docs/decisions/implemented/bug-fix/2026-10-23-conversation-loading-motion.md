# Decision Record: Steady conversation loading with restrained motion

Status: implemented

## Problem

The conversation placeholder repeated the same short opacity cycle in every paragraph. Its many independently animated rows appeared to blink together, drawing attention to the wait. The preceding preparation notice used a small bordered action whose appearance differed from the neutral controls in Settings.

## Decision

The placeholder keeps its lines at a fixed opacity and moves one broad, softly graduated layer across the visible pane using a CSS transform. The gradient uses the conversation canvas theme token, so it changes contrast locally without introducing a separate palette. Its edges travel outside the clipped pane before the cycle restarts. The existing view activity context pauses it when inactive, and reduced motion removes the decorative layer. Retry remains above the decoration and accepts pointer and keyboard input.

This supersedes only the per-line animation in [the conversation-column placeholder decision](2026-10-22-conversation-loading-placeholder-shape.md). Geometry, accessible loading status and immediate static admission remain unchanged. Animation does not measure progress or delay readiness.

Preparation actions use a local style with the neutral inset tokens used by Settings, no border or shadow, a rounded 36 px target and shared keyboard focus treatment. Shared Button defaults and preparation, navigation and retry logic remain unchanged.

## Alternatives considered

**Randomize each row's pulse or delay.** This retains many independently changing contrasts and introduces complexity without giving the reader a stable waiting surface.

**Add a moving gradient to every row.** This multiplies animation layers by placeholder length, including clipped rows. One pane-sized layer has bounded rendering work.

**Restyle the shared secondary Button or apply the Settings scope to the notice.** Changing the shared default affects unrelated controls; importing a Settings layout scope misstates ownership. A local action style consumes the same public tokens without either dependency.

## Consequences

Loading remains visibly active while the underlying line positions and contrast stay steady. The motion is still a repeating indeterminate indicator, not a representation of completed work. One canvas-colored gradient assumes the placeholder occupies the conversation canvas; future reuse on another surface must supply that surface's canvas token.

Production-built browser fixtures cover timed geometry and opacity samples, both themes, narrow layouts, pause/resume, reduced motion, keyboard focus, retry and navigation. The preparation fixture retains its admission, cancellation and warm-cache checks while using the actual font and style cascade.
