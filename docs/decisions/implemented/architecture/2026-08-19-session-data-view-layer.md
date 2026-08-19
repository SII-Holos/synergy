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

### Explicit exemptions (undefined-carrying loading semantics)

The following direct store reads are intentionally NOT routed through the view layer. Each site branches on `undefined` to distinguish "not loaded" from "loaded empty"; the view layer's shared empty arrays (always truthy) would silently change that behavior. Each site carries an inline `Explicit exemption` comment in code.

- `packages/app/src/pages/session.tsx` — `decideSessionTransitionHandoff` calls (inbox) and `recoverSessionTransitionHandoff` (messages + inbox): handoff resolution branches on `inbox === undefined` to trigger refresh and distinguishes "not loaded" from "loaded empty" during session recovery.
- `packages/app/src/pages/session.tsx` — mobile review `Show when={session_diff}` and `tool-session-review.tsx` `sessionDiffs`/`loadDiffs`: `undefined` renders the "loading changes" fallback and gates diff fetching.
- `packages/app/src/context/local.tsx` — `resolveSessionVariant` messages input: `undefined` means "session not ready" for variant resolution.
- `packages/app/src/components/session/session-inbox.tsx` — `deriveSessionInboxView` input: `undefined` yields the `loading` status (this file WAS migrated to the view layer — `inboxFor` returns the shared empty array for a missing bucket, which `deriveSessionInboxView` maps to the `empty` status; see `session-inbox-utils.ts`).
- `packages/app/src/context/session-data-view.ts` — the view layer itself and `sync.tsx` internals are the only remaining store reads by construction.

The full migration inventory lives in the PR description for #1211; the grep gate (`sync.data.<sessionField>[` / `data.store.*` outside view-layer and the exemptions above) is part of the done criteria.

### LLM-dependent manual scenarios — automated-test substitution (user-accepted)

The Blueprint's manual acceptance section lists two LLM-dependent scenarios that could not run in the isolated dev instance: (b) BlueprintLoop execution with sub-session navigation, and (d) streaming reply completion state and scroll position. The isolated instance could not reach any LLM provider (internal endpoints fail certificate verification under Bun 1.3.14 — `Bun.disableTLSVerify` is absent and `NODE_TLS_REJECT_UNAUTHORIZED=0` is not honored — and the remaining reachable endpoints return 401 without credentials, whose store is blocked from copying by the secrets permission boundary). On 2026-08-20 the user explicitly accepted automated-test substitution for these two scenarios: `session-switch-stress.dom.test.ts` (rapid bucket replacement/clearing, whole-store clear/restore, projection index-miss, final-content correctness — 5 cases, zero render errors) plus the CI Smoke Test cover the same switching machinery, while scenarios (a) rapid switching (11+ switches) and (c) cross-scope switching with refresh were verified in a real browser with zero console errors.
