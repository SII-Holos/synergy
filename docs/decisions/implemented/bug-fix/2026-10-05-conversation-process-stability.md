# Decision Record: Conversation process stability

Status: implemented

## Problem

Reasoning expansion can cross an inner scrolling threshold while the outer conversation is following. Conditional padding and scrollbar allocation change geometry, and resize-driven following then moves the reader. Mount-driven entrances replay historical work after navigation. Empty canonical reasoning can retain an expandable display summary even when only encrypted provider evidence exists.

## Decision

Process windows retain natural height with the existing 320px, 240px and 45% bounds. Scrollbar allocation is unconditional; flat alignment and 24px themed edge overlays do not change layout. The fades resolve to the conversation canvas background rather than a raised card surface so their opaque ends blend into the surrounding content. User disclosure captures inner Part or paragraph and outer reading positions before mutation. Reading intent applies before overflow. Every size commit restores through the owning virtualizer, including the offset inside a grouped row; absent paragraphs fall back to their reasoning trigger. Resize only measures or restores. Live revisions while following and explicit Latest request bottom movement. A quiet accessible icon and End return to the local latest position.

Body hydration and unsequenced stream text can reshape a mounted row while its summary version remains constant. A viewport-owned content mutation observer protects reading before the virtualizer processes that resize. It schedules the existing coalesced restoration without measuring, resuming following or granting entrances. Both observers and pending frames are released with the viewport.

Completing a missing summary page renews mounted body leases regardless of whether the row previously observed a ready page. Reconnect can invalidate already hydrated bodies while the first page remains pending; a resolved lease cannot establish that the cache still holds its content. Renewal reuses accepted cache entries and fetches invalidated bodies through the existing loading path, preserving explicit failures and cancellation.

Foreground live summary acceptance grants bounded, short-lived Part entrance receipts after baseline loading. Server, Scope, Session and view ownership fence consumption and cleanup. Snapshots, discovery, replay, body loading and remount grant no receipt. Visible new content fades once for 180ms; parent containers have no entrance. Manual disclosures retain interruptible 180ms/240ms motion with reading protection. Reduced motion completes immediately. Real body increments retain streaming suffix effects.

The canonical Part summary omits empty or whitespace-only reasoning from rendering while preserving raw Parts and encrypted metadata. A registered Session migration invalidates prepared and partially prepared display-index metadata in batches of 100, advances generation and clears preparation cursors. The existing paged preparation rebuilds summaries, including imported records. Loading and failures retain recovery controls; only successfully loaded empty reasoning hides its control. Existing HTTP methods and plugin interfaces remain compatible. The optional reasoning identity in summaries follows the companion [continuous reasoning decision](2026-10-05-group-continuous-reasoning-item-fragments.md).

## Alternatives considered

**Only restyle the window.** This removes the discrete geometry change but leaves resize-driven following and mount-driven replay intact.

**Remove independent scrolling.** This changes the selected reading model and lets long tool histories dominate the conversation.

**Treat every new DOM node as live content.** Virtualization, Session navigation and lazy body reads repeatedly mount historical nodes, so mounting cannot establish arrival.

**Invalidate old summaries during requests.** This hides a persisted-state upgrade in the hot path and leaves import behavior inconsistent with central migration ownership.

## Consequences

Reading protection and arrival eligibility have explicit owners and lifetimes. Process windows keep bounded DOM, cached scroll positions, retained focus/selection and lazy body leases. The outer virtualizer also retains the current local reading owner, even without focus, until another process takes ownership or an outer reading gesture or locator releases it; this adds at most one retained process row. Anchor restoration adds measurement during disclosure; tests must cover virtual size commits and grouped Part offsets. Expired or offscreen receipts deliberately render statically. Automated geometry, replay, empty-content and migration tests cover regressions; physical trackpad behavior remains a device-specific check. The failure mechanism and guardrails are recorded in [the postmortem](../../../postmortem/0048-process-layout-and-arrival-ownership.md).
