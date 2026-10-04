# Decision Record: Independent review navigation and visible reading controls

Status: implemented

## Problem

Review navigation shared a filter with the diff projection, so quick lookup could hide other files and release their rendering state. Common reading settings were buried while lower-frequency navigation consumed toolbar space. Folding used surface-sizing glyphs, mixed target sizes made controls inconsistent, and narrow file-list settings could change without a visible result. Refresh also replaced loaded content before its comparison settled.

## Decision

The existing [versioned review surface](2026-10-04-review-frontend-optimization.md) retains its HTTP and persistence contracts. Comparison scope, totals and editable references share one metadata group. Reading tools have fixed ordering and dedicated semantic icons. Layout opens explicit Auto, Unified and Split choices; Wrap and Files expose complete pressed states. More owns advanced display, comments, adjacent-file navigation, exports and historical restoration.

Quick jump uses a virtualized flat list with basename, directory and workspace labels. It supports directional selection, explicit Enter activation, composing-input protection and Escape focus recovery. The directory remains a separate browser on the right of wide diffs and opens as a popover in narrow panes. Neither navigation query changes diff membership, content caches or selected lines. Viewer items retain identity when their content and display projections have not changed. Highlight-cache identities include captured content versions and projection settings, so placeholder metadata cannot collide with a later full file. Same-comparison refresh retains content through pending and failure; successful comparisons revalidate loaded versions under the existing cancellation and bounded-read owner.

Desktop controls use 32px targets with 16px glyphs. Touch uses at least 44px targets and moves Refresh/Fold into More when necessary. Narrow panes reserve separate metadata and tool rows. Theme tokens distinguish neutral, hover, pressed and keyboard-focused states; existing fast motion remains reduced-motion aware.

## Alternatives considered

**Reuse the directory filter for quick jump.** It made the picker cheaper to compose but silently removed unrelated diff content and invalidated state. Lookup and directory filtering now remain local to navigation.

**Cycle layouts on icon activation.** It reduced the menu to one action but required remembering a hidden mode order. Explicit checked choices expose the current mode and allow direct selection.

**Keep the directory on the left.** It retained the earlier panel structure but interrupted the reading surface before its content. The right directory preserves content-first scanning and shares the same Files control with narrow popovers.

## Consequences

The panel exposes frequent reading actions while retaining existing comparison, annotation, export and restoration authorities. Independent picker/tree state adds frontend composition. Both navigation collections virtualize large comparisons; directory focus retains its previous row until the destination is mounted and focused. Virtualized options need active-descendant and focus tests. The actual panel and production styles are exercised by `apps/web/test/components/workspace/review-panel.dom.test.ts`; renderer coverage remains browser-owned while queue and projection unit coverage stays measured.
