# Decision Record: Stabilize sidebar disclosure and list motion

Status: implemented

## Problem

Expanding a project after scrolling can move every project by the accumulated scroll distance. List animation compares cached viewport coordinates, and expanded-state updates rebuild the ID array even when its contents and order remain identical. Height changes between snapshots also leave outdated positions for a later genuine reorder. Reduced-motion-only collection tests conceal the movement.

## Decision

Sidebar disclosures use the shared base duration and emphasized easing. The activated heading and preceding content remain stationary when scroll bounds permit; following projects move with the child list's height. Disclosure does not programmatically adjust scrolling. Native scroll-bound clamping remains effective when content shrinks.

`FlipList` schedules movement only when the ordered stable IDs change. A Solid computed registered before keyed child rendering captures the current visible positions; the next animation frame measures committed positions relative to the list container. Same-frame updates retain the first capture and use the final layout. Reordering during animation starts from the currently displayed positions. Only list-owned Web Animations are cancelled, and pending frames and media listeners are released on disposal. Hidden updates do not replay on opening. Reduced-motion preference changes cancel current movement immediately.

Genuine reorders use the shared base duration and standard easing without per-row delay. New visible entries retain a short entrance using the shared fast duration. Initial mounting remains unanimated. This complements the server/index suppression and initialization guarantees in [unrelated navigation refresh](2026-09-02-stop-sidebar-project-refresh-jump.md).

The existing collection browser fixture covers normal-motion scrolling, cached and held session loading, equivalent refreshes, keyboard reversal, geometry after disclosure, live reduced motion and coalesced reordering. Model coverage retains entrance, movement and reduced-motion behavior while replacing the obsolete cached-baseline assertions with current-origin and owned-animation checks.

## Alternatives considered

**Only change the easing or cap translation distance.** Either approach conceals incorrect coordinates while retaining accidental whole-list movement and distorting genuine reordering.

**Disable all list motion.** This removes useful feedback when projects or sessions actually change order and is unnecessary once animation admission and measurement are correct.

**Normalize cached viewport positions alone.** Container-relative coordinates eliminate common scrolling offsets, but unchanged-ID refreshes still trigger movement and disclosure can leave stale row heights. Measuring immediately around a genuine identity change addresses both failures.

## Consequences

Expansion remains local and real list changes retain feedback. Layout reads occur only around ordered-ID changes instead of metadata refreshes. The controller owns a bounded frame and animation set per list, with no persistent layout observer. Browser regressions share the existing fixture preparation and exercise actual animation frames; fake geometry tests remain focused on the small animation controller.
