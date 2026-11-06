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
- [Production navigation verification](../../apps/web/test/fixtures/workbench/verify-session-switch.ts) delays capability reads and event replay, then checks pending rows for exposure and every admitted frame for bodies and latest positioning across cached and rapid switches, both themes and phone layout.
- [The frontend workflow](../../.synergy/skill/develop-frontend/SKILL.md) records composed navigation verification; [the decision](../decisions/implemented/bug-fix/2026-10-07-session-switch-display-admission.md) records bounds and tradeoffs.

## Follow-up: Project metadata suspended the entire cold Session route

On 2026-10-13, new Worktree Sessions consistently showed an empty right pane for several seconds, and older Sessions showed the same symptom intermittently during navigation. Isolated Chromium reproduced the failure without a page error by holding the project-directory request after the target Session route became active. The active resident container had zero children and no Composer; releasing that request restored the toolbar, messages and editor together. A main-directory Session and an existing Session produced the same result. Warm resident returns issued no directory read, while returning after view eviction reproduced the blank pane. Holding storage preparation or timeline reads alone preserved the shell, distinguishing those existing local loading states from the metadata failure.

The Session page created a directory resource without an initial value and read `latest` in `mainFolder` and dependent memos. Its first `latest` read still registered pending work with the enclosing route-wide Suspense. That Suspense had no fallback, and the outgoing resident was already hidden. Existing optimistic submissions remained stored but their presentation was inside the suspended subtree. The directory resource now has an explicit null initial snapshot; owner filtering, local errors, refreshes and the existing history-loading paths remain intact.

The [directory DOM regression](../../apps/web/test/components/session/project-directory-resource.dom.test.ts) was red before the fix and covers cold and evicted views, warm DOM/draft continuity, refresh failure and obsolete-owner replies. The [resource behavior test](../../apps/web/test/components/session/project-directory-resource.test.ts) covers the generated SDK and pending, success, error and mutation states. The [decision](../decisions/implemented/bug-fix/2026-10-13-non-blocking-project-directory-metadata.md) records why this belongs at the metadata resource rather than a Worktree-specific fallback.

## Lessons

A retained cache does not imply retained presentation. Snapshot producers and render consumers must use the same content protocol, and visibility needs an explicit owner that includes initial positioning rather than headers alone. A `latest` resource read is not non-suspending until it has an explicit initial value; optional metadata inside a route-wide Suspense can hide otherwise-ready and optimistic content.
