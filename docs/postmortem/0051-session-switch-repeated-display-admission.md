# Session switching repeated display admission

## Executive summary

Session switching exposed multiple intermediate frontend states because storage readiness, timeline headers, lazy bodies, initial scrolling and plugin component loading each admitted presentation independently. Per-row identity tests did not cover their composition. The guardrail is to verify the first visible viewport, including bounded content preparation and Session-bound plugin service disposal.

## Summary

Returning to a cached conversation could replace it with preparation UI, restore metadata before text, show the top of the list before initial bottom positioning, and replace a native fallback with a loaded plugin page. The existing shared store retained data, but the presentation still cycled through these stages.

## Timeline

- 2026-10-07: A user reported repeated flicker and display refreshes during Session switches.
- Investigation traced preparation admission, navigation prefetch, summary/body loading, initial scrolling and the plugin Shell surface.
- Behavioral regressions reproduced cached readiness loss, plugin fallback replacement and premature viewport visibility before the corresponding fixes.
- 2026-10-08: A browser pixel regression reproduced virtual rows painting through the pending viewport's inherited visibility. Subtree opacity corrected the leak without changing layout or admission ownership.

## Root cause

Storage preparation reset readiness on every route change. Prefetch wrote the full-message protocol while foreground rendering used timeline headers, Part summaries and versioned bodies. Initial scroll ran several frames after visible mount, and lazy hydration changed geometry afterward. Initial connection recovery could clear already admitted cached bodies before their leases renewed. The latest-following hook deferred resize correction to the next animation frame, exposing one resized frame before it pinned again. Shell resource initialization selected the fallback even when the same module was already loaded. Reconciliation covered message replacement inside mounted rows rather than these presentation owners.

The viewport's initial visibility gate still allowed virtualized children with explicit visible styles to paint. Accessibility state and admitted-frame-only checks reported the gate as closed while those pixels exposed intermediate layout. The regression now measures pixels before admission as well as after it, with the real virtualizer and independently delayed body and layout readiness.

## Guardrails added

- [Preparation regression](../../apps/web/test/components/session/session-preparation.dom.test.tsx) and [cache isolation](../../apps/web/test/context/session-preparation-cache.test.ts) cover cached return and server ownership.
- [Bounded warming](../../apps/web/test/context/session-viewport-content.test.ts) and [actual store publication](../../apps/web/test/context/global-sync-part-repair.dom.test.ts) cover versions, freshness and shared-budget eviction.
- [Browser viewport regression](../../apps/web/test/components/session/conversation-row-retention.test.ts) independently delays bodies and layout, verifies pending rows retain geometry without painting, then checks visible pixels through streaming and target replacement.
- [Latest-following regression](../../packages/ui/test/hooks/create-auto-scroll.test.ts) checks that delayed growth lands before another frame and explicit reading cancels following.
- [Shell lifecycle regression](../../apps/web/test/plugin/shell-surface.test.ts) checks module reuse without retaining the previous Session’s services.
- [Production navigation verification](../../apps/web/test/fixtures/workbench/verify-session-switch.ts) delays capability reads and event replay, then checks every admitted frame for bodies and latest positioning across cached switches, both themes and phone layout.
- [The frontend workflow](../../.synergy/skill/develop-frontend/SKILL.md) records composed navigation verification; [the decision](../decisions/implemented/bug-fix/2026-10-07-session-switch-display-admission.md) records bounds and tradeoffs.

## Lessons

A retained cache does not imply retained presentation. Snapshot producers and render consumers must use the same content protocol, and visibility needs an explicit owner that includes initial positioning rather than headers alone.
