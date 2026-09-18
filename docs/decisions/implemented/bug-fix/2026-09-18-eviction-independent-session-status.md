# Decision Record: Session row identity and runtime state outlive the Scope store

Status: implemented

## Problem

Sidebar session rows flickered while the user switched sessions or projects: a running session's spinner collapsed into a generic glyph, then a spinner returned without its Blueprint or worktree identity, then the identity came back. The cause was one data dependency, not three bugs.

`resolveSessionVisualState` (`apps/web/src/components/sidebar/session-visual-state.ts`) resolved every rich state inside an `if (store)` gate, where `store` came from `globalSync.peekScopeState(scopeKey)`. That per-Scope store is evicted the moment its last retention lease is released (`apps/web/src/context/scope-retention.ts`), and the lease is released as soon as the user leaves the project — the release path evicts directly rather than joining the eight-slot inactive LRU that the `touch` path uses. Re-creating the store produced an empty shell whose bootstrap waited behind a two-slot request queue, so for a window the row had no status, no Blueprint binding, and no workspace type. Because events recreate an evicted store, the cycle could repeat for as long as the session kept working.

The same gate made identity unreachable for a second reason: `session_status`, `permission`, and `question` were also stored per Scope even though every consumer of them reads across Scopes. Surfaces that render many sessions at once — sidebar rows, the mobile drawer, the Kanban board, the status bar — therefore showed no running or waiting state for any session outside the currently leased Scope.

Two smaller defects shared the root cause of duplicated classification. `recovering` had no branch in the sidebar resolver, so a recovering session read as idle there while the status bar and Kanban both treated it as work. `retry` rendered the running glyph in the sidebar and the retry glyph in the status bar. Kanban additionally treated a _missing_ status as working, because `undefined?.type !== "idle"` is `true`.

## Decision

Session _identity_ and session _runtime state_ move to two carriers that no eviction path touches, and the resolution becomes a pure function over them.

Identity travels on the navigation entry. `SessionNavEntry` (`packages/harness/src/session/nav.ts`) gains `blueprint` (with a denormalized `phase`), `workspaceType`, and `workflow` (`kind` plus a backend-derived `active`). The nav projection is paginated, persisted, and refreshed by `session.updated`, and both producers — `toNavEntry` and `buildNavIndexUnlocked` — project the new fields from the full `Session` they already parsed. A migration rebuilds persisted nav indexes so pre-existing sessions gain the fields. The Blueprint loop store writes `blueprint.phase` at its single status transition point, which removes the sidebar's previous cross-session lookup through `cortex` and a child-session `session.find`.

Runtime state moves into the always-present global store (`apps/web/src/context/global-sync.tsx`), keyed by session ID, which is globally unique: `sessionStatus`, `permission`, and `question`. The index holds only non-idle statuses, so an `idle` event deletes the key. `GET /global/session/status` (`global.session.status`) is the cross-Scope snapshot, and it merges each Scope's recoverable statuses — the only path by which `recovering` reaches a client, because no producer publishes it on the event bus. `GlobalRuntimeWriteTracker` (`apps/web/src/context/global-runtime-state.ts`) applies the same post-stamp precedence the Scope buckets use, and a `session.updated` carrying `info.working` fills a status the index has no entry for, with a real status event always winning.

Classification is shared; presentation stays local. `apps/web/src/utils/session-status.ts` owns `isWorkingStatus` and `classifySessionActivity` — the one place that decides whether a status means work, with `waiting` outranking it and `recovering` counting as work. Display surfaces (sidebar, mobile drawer, Kanban header and row copy, ActiveZone, status bar, subsession row) keep their own glyph, tone, and copy, and read the shared decision.

## Alternatives considered

**Hold a Scope lease for every Scope the sidebar renders.** Would keep the store alive and fix the flicker without moving data, but pins every visible project in memory, contradicting the bounded-memory invariant that allows at most eight unleased background Scopes, and grows with the number of open projects.

**Downgrade a released lease into the inactive LRU instead of evicting.** Smaller change, and it removes the immediate-eviction asymmetry, but state would remain bounded by eight Scopes, so the defect would persist at a lower frequency rather than being fixed.

**Mirror the runtime state into a second evictable store or a component-level memo.** Creates parallel state whose copies diverge on eviction and reconnect timing — the same class of cause as the drift this change removes.

**Add a third copy of the Light Loop terminal-status list on the frontend.** Two copies already exist (backend `light-loop-state.ts`, web `light-loop-control.ts`). The backend instead derives `workflow.active` through a synchronous registry predicate and ships the result, and the frontend consumes it.

**Let the frontend call `WorkflowPromptRegistry.isActive` to decide activity.** That predicate is asynchronous while `toNavEntry` runs synchronously inside `Session.create`/`update` transactions, so it cannot be awaited there.

**Poll `/session/status` from the sidebar.** The route is Scope-filtered and would not cover a cross-project view, and per-event REST refetches are prohibited by the App architecture rules.

**Keep the `cortex` cross-session lookup for the Blueprint audit phase.** That lookup was the most fragile input in the resolver: it needed both the scope's Cortex tasks and the child sessions of a store that may have been evicted. Denormalizing the phase onto the bound session preserves the same backend authority on a stable carrier, consistent with how the Blueprint domain already writes `loopID` and `loopRole` onto sessions.

## Consequences

A session row keeps its identity and its running or waiting state while its Scope store is gone, so switching project no longer degrades the sidebar. Surfaces that render sessions from several Scopes now see the same runtime state for all of them.

Classification drift is closed at the source: `recovering` renders as a distinct intervention state everywhere instead of reading as idle in the sidebar, `retry` and `recovering` share the status bar's retry glyph and critical tone, and a missing status is no longer mistaken for work. This is an intentional change to how those states look; the sidebar previously showed a running spinner for `retry`, and unchanged behavior was not a goal.

Costs: `SessionNavEntry` is a public schema shared by `session.index`, `global.nav.recent`, `global.nav.pinned`, and the `session.updated` payload, so the new fields required regenerating the SDK and a nav-index rebuild migration; the two projection functions must be changed together or entry shape diverges by write path; and the global index adds one post-stamp tracker whose key space is flat rather than `(Scope, session)` because the state is not Scope-scoped. `BlueprintLoop` sessions now depend on the loop store keeping `blueprint.phase` current, so a future loop-status transition that bypasses the shared write helper would let the sidebar phase drift from the loop.

The sibling decisions this builds on: [merge-stale-bootstrap-snapshots](2026-09-15-merge-stale-bootstrap-snapshots.md) established the post-stamp precedence this change reuses, [mobile-session-visual-state-icons](2026-09-04-mobile-session-visual-state-icons.md) established that desktop and mobile share one resolution, and the superseded [blueprint-sidebar-audit-state](../../archived/bug-fix/2026-08-28-blueprint-sidebar-audit-state.md) established that audit state must come from the authoritative backend binding rather than a running-child heuristic — this change keeps that guarantee while moving the carrier from a child-session lookup to the denormalized loop phase.
