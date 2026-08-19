# Decision Record: Session data view layer — null-safe session store access

Status: implemented

## Problem

Session switching crashed the Solid.js render chain with a rotating set of `TypeError`s (`Cannot read properties of undefined (reading 'find'/'filter'/...)`) at different call sites on each occurrence. Root cause: the render chain read session-shaped fields directly off the shared scope store (`sync.data.<field>[id]` in app, `data.store.<field>[id]` in ui), and session switches race the store's intermediate states — the next session's buckets are missing until its window loads, a whole scope store is released while an old tree is still unmounting, and `createMemo` default values stop applying once a memo has computed once. Each fix (45+ commits since 2026-04: `b0fa7fcf0`, `6cdd685be`, `170cfae13`, `014be8f7b`, `57f8da845`, `6968eb569`, …) patched the one call site that happened to throw, so the same propagation mechanism survived and surfaced at the next unguarded read.

## Decision

Add a **session data view layer** that owns every session-shaped store read in the render chain:

- `packages/ui/src/context/session-data-view.ts` exports `createSessionDataView(data)` — a factory of thin null-safe accessors (`partsFor`/`messagesFor`/`permissionsFor`/`statusFor`/`diffsFor`/`inboxFor`/`todosFor`/`dagNodesFor`/`questionsFor`/`cortexTasks`/`sessions`/`sessionFor`/`partTable`). Every accessor applies its `?? EMPTY` fallback **inside the function body** on each evaluation, so it never depends on `createMemo` default-value semantics.
- Missing buckets return **module-level shared empty arrays** (`EMPTY_PARTS`, `EMPTY_MESSAGES`, …), never fresh literals: the render chain's `same()` equality guards (session-turn.tsx) short-circuit on reference identity, so a fresh literal per evaluation would invalidate every downstream memo on each store tick and regress the projection-memoization work (`013a2271b`).
- `useData()` keeps its existing shape (`store`/`directory`/`serverUrl`/callbacks) and gains a `view` getter; the `Data` type gains the session fields that already existed at runtime (`inbox`/`todo`/`dag`/`question`/`cortex`). Existing consumers and test mocks are untouched.
- App components read through `useSessionDataView()` (a `createMemo` wrapping `createSessionDataView(sync.data)`); ui components read `data.view`.
- The projection chain keeps two final guards that are independent of the view: `latestAssistantTimelineItems` restores `displayItemProjections()[index]?.() ?? []` (the `6968eb569` regression — `display` and the projection mapArray recompute on their own lazy schedules during a window replacement), and `turnMessagesFor(undefined)` returns `[]` (conversation.tsx passes the row getter as the anchor).
- The window snapshot gate (`hasMessageWindowSnapshot`) and the `TimelineDisplay` ErrorBoundary are preserved unchanged as the loading gate and the last-resort isolation boundary.

## Alternatives considered

- **Keyed whole-tree rebuild on session switch** — rejected: destroys the row-getter + keyed-`For` leak-prevention architecture (the 4 GiB V8 OOM fix in `conversation-timeline.ts`) and loses scroll/Markdown state (the reason `57f8da845` reverted keyed `Match`); also only removes today's known crash sites, not the undefined-propagation mechanism.
- **Push parts/permissions into `SessionTurn` props** — rejected: moves the scattered reads to the call site instead of removing the undefined source, and changes the public `@ericsanchezok/synergy-ui/session-turn` surface.
- **Change `useData()` return shape** — rejected: breaks all 13 consumers and the public `@ericsanchezok/synergy-ui/context` contract for no mechanism gain.
- **Per-call-site `?.` guards only** — rejected: this is exactly the repeated whack-a-mole that produced 45+ commits; the view layer makes the empty-safe fallback structural rather than incidental.

## Consequences

New components that read session-shaped store fields through the view layer cannot observe `undefined` for array fields, so the crash class is closed at the mechanism level instead of per call site.

The shared empty constants are a hard constraint: a fresh array literal in an accessor silently defeats the `same()` guards and regresses streaming projection performance. Enforced by `develop-frontend` skill rule and by the view-layer unit test that asserts reference identity (`===`).

Read paths keep their exact reactivity: accessors are thin closures whose store-field access happens inside the calling memo, so Solid store path subscription is unchanged.

Public API impact is additive only: `useData()` gains `view`, `Data` gains optional fields, `SessionTurn`/`TimelineDisplay` props are unchanged.

Coverage: view-layer null-safety matrix + identity test, `session-switch-stress.dom.test.ts` (rapid bucket clearing/replacement and whole-store clear/restore with zero render errors), and `turnMessagesFor(undefined)` projection test.
