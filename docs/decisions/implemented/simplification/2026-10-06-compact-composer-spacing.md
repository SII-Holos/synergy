# Decision Record: Compact the default Composer and reserve bottom space

Status: implemented

## Problem

The empty Composer dedicates more vertical space to writing than a short draft needs, while its small bottom gap makes the input surface appear pressed against the window edge. Mobile safe-area padding replaces the ordinary gap rather than adding to it. Dock content-box measurements omit that padding, so increasing the gap alone leaves conversation clearance and expanded editor sizing inconsistent with the visible surface.

## Decision

The normal editor minimum is 64 pixels. Desktop bottom space is 24 pixels, reduced to 16 pixels at window heights of 640 pixels or less; below 768 pixels width it is 12 pixels plus the safe-area inset. Font metrics, toolbar geometry and 44-pixel touch actions remain unchanged. Automatic growth retains its 240-pixel or 40-percent available-height cap and grows upward from the same bottom anchor before and after first send. Very short windows may use a lower minimum within the existing measured limits.

The [quiet sizing controls](2026-10-02-quiet-composer-sizing.md) and single-editor behavior remain intact. The Dock reports its complete border-box height through a reactive observer target. Border-box observation must not filter events by unchanged content-box dimensions, because a padding-only change alters the space the conversation must avoid. Expanded editor sizing deducts the actual Dock bottom padding and preserves eight pixels of top clearance instead of assuming a fixed combined gap.

The [Web product contract](../../../../apps/web/PRODUCT.md) owns the current geometry. Competitor layouts informed compact-start and separate-bottom-space choices, not a shared numerical standard; the [frontend development Skill](../../../../.synergy/skill/develop-frontend/SKILL.md) supplies the reusable verification procedure. No public Plugin API, persisted preference or editor service changes.

## Alternatives considered

**Only move the card upward.** This improves the bottom gap but retains unnecessary empty editor height and leaves content-box clearance incorrect.

**Shrink the whole card to a single compact row.** That requires changing font or toolbar dimensions, disrupts the established two-region layout and risks touch reachability. This change removes unused writing space instead.

**Use only the mobile safe-area inset.** Devices with a zero inset would still place the card against the edge; the base gap must be additive.

**Use the shared content-box-deduplicated resize helper with border-box observation.** It suppresses padding-only events when content dimensions remain unchanged. The lower-level observer retains mount cleanup without that filter.

## Consequences

Short prompts use less vertical space while the card retains a visible gap. Long drafts, manual sizing and expanded editing remain available without changing text or input ownership. The outer gap consumes some expanded editor space, deliberately keeping the surface inside its pane. Browser regression tests cover compact defaults across desktop, short and mobile viewports, full-height reporting after padding-only changes, late mount and shell replacement, first-send anchoring, long-input scrolling, resize cancellation, keyboard sizing and expansion motion with native selection and undo.
