# Decision Record: Draggable persisted sidebar width and top-bar outline

Status: implemented

## Problem

The global sidebar had a fixed CSS width (300 px) with no way to adjust it, even though the layout store already exposed `sidebar.width` / `resize()` — the persistence pipeline existed but had zero consumers. Separately, the session top bar lost its bottom outline on desktop when 20d96f9d4 converted it to an absolute overlay (`border-bottom: none` inside the `min-width: 768px` block); the outline removal was incidental to the mobile flex-column fix, not a deliberate product decision, and users noticed the chrome boundary disappearing.

## Decision

- Sidebar width becomes a user-adjustable preference driven by the shared `ResizeHandle` from `@ericsanchezok/synergy-ui` (same component as Side Workspace and the file Explorer), mounted on the trailing edge of the expanded sidebar only.
- Constants live in `packages/app/src/context/layout/defaults.ts`: `SIDEBAR_WIDTH_DEFAULT 300` (matches the previous CSS fixed width), `MIN 230`, `MAX 420`, `SIDEBAR_COLLAPSE_THRESHOLD 230`; `clampSidebarWidth` and `effectiveSidebarWidth` are the single normalization helpers shared by the store, migration, and handle. The band floor equals the collapse threshold so a persisted width can never reopen below it and re-collapse on a press-and-release.
- `resize()` writes `{ width, resized: true }`; the width getter (`effectiveSidebarWidth`) ignores stored widths without the `resized` flag and falls back to the default. Width is persisted in the global layout store (`synergy.global.dat:layout`), not per-workspace, because the sidebar is global navigation.
- `migrateWorkbenchLayout` normalizes sidebar state: a flagged width is kept but clamped into the band; an un-flagged width is dropped entirely. Every historical installation carries the old dead default `width: 280` with no flag, so this prevents legacy dead data from overriding the 300 default.
- The expanded root element renders its width as an inline style; `.sb-expanded { width: 300px }` remains only as a pre-hydration fallback. A `sb-resizing` class disables the width transition during drag (same pattern as `.workbench-surface--resizing`).
- Dragging below the collapse threshold closes the sidebar to the 48 px rail via the handle's `onCollapse`. The Sidebar component only mounts on desktop (`layout.isDesktop()`), so the mobile drawer is unaffected.
- The desktop top-bar media query keeps the absolute positioning but no longer resets `border-bottom`, restoring the hairline outline in both mobile and desktop.

## Alternatives considered

- **CSS-only fixed width** — rejected: the user asked for adjustable + remembered width, and the store API already existed; CSS-only would leave `resize()` permanently dead.
- **Consuming stored width without a `resized` flag** — rejected: all existing installations persist the unconsumed default `280`; honoring it would silently widen every upgraded sidebar.
- **Per-workspace width persistence** — rejected: the sidebar is one global navigation surface (unlike the session-scoped Side Workspace); its width is a single user preference.
- **Keeping the top bar borderless on desktop** — rejected: the border removal rode along with an unrelated mobile keyboard-layout fix (20d96f9d4) and had no product rationale; the outline distinguishes chrome from content.

## Consequences

- The sidebar can be dragged or keyboard-stepped between 230–420 px, collapses below 230 px, and the chosen width survives reloads and workspace switches as one global preference; reopening never lands below the collapse threshold.
- Legacy installs (dead `width: 280`, no flag) migrate to the 300 default rather than the stale value; explicitly resized widths are preserved but clamped.
- The desktop session top bar shows its hairline outline again in both themes.
- The shared `ResizeHandle` is pointer-driven (touch drag via `setPointerCapture`, `touch-action: none`), focusable with `role="separator"`, arrow/Home/End stepping, and localized accessible names at all three consumers (sidebar, side workspace, file explorer).
- Side-workspace default and maximum widths subtract live sidebar occupancy (`sidebarOccupancy`: persisted width when expanded, 48 px rail when collapsed, 0 on mobile), and a persisted workspace size that no longer fits is clamped at render time instead of clipping the session column.
- `.sb-root` disables its width transition under `prefers-reduced-motion: reduce`.
- Tests pin the three migration semantics (drop un-flagged, clamp flagged, idempotent), the clamp/effective-width helpers, the band-floor ≥ threshold invariant, `sidebarOccupancy`, the separator keyboard model, and the existing surface suite stays green.
