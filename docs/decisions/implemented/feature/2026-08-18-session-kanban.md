# Decision Record: Session Kanban board — multi-session live stream view

Status: implemented

## Problem

Users run several sessions concurrently (long-running evals, scheduled inspections, channel-backed agents, Blueprint loops) and need to watch them at a glance. The Web app only offered one session at a time; checking N sessions meant N page switches, and nothing aggregated "which sessions are running or waiting for me" across scopes. A board view that renders multiple sessions' live message streams on one screen would close that gap without changing how sessions are stored or streamed.

## Decision

Add a **Kanban** board page (`/kanban`) to the Web app, reachable from a fixed sidebar entry (order 15, between Agenda at 10 and Library at 20) and the mobile drawer. It renders up to six panes, each streaming one session's live messages, in two switchable layouts (grid, focus+rail). Each pane has a follow toggle and a small composer that posts plain-text input to the session via `session.input` (agent/model fall back to the session's last used values server-side), so the board is a live control surface rather than a read-only monitor. The pane set follows a mixed policy: pinned sessions (persisted via `Persist.global`) always occupy slots; leftover pinned keys whose session vanished become removable "unavailable" placeholders; remaining slots are auto-filled by running and waiting sessions ordered by last activity. Layout, per-pane follow toggles, and pinned set persist in localStorage.

The board is a pure frontend view-layer feature. It reuses the existing global event stream and per-Scope stores (`globalSync.ensureScopeState`/`peekScopeState`), the layout nav lists (`recentEntries`/`rootNavEntries`/`projectNavEntries`) as the session index, and the `messagePage` loader pattern already proven by sidebar prefetch. Each pane wraps the shared UI message components (`SessionTurn`/`MailboxMessage`/`CommandResultOutput`) in its own `DataProvider` scoped to the target store, with an independent `createAutoScroll` follow toggle. No server, SDK, protocol, or persistence-schema change was made.

Two sync-layer generalizations support it:

- **Eviction protection set.** `global-sync.tsx` now keeps `protectedBucketKeys: Set<string>` alongside the single `activeBucketKey`. `evictMessageBuckets` unions both into the protected set passed to `planBucketEviction`; the board calls `protectMessageBucket(scopeKey, sessionID)` on pane mount and `unprotectMessageBucket` on unmount, so live panes are never blanked by LRU eviction while the single-active-session semantics and all existing callers stay untouched.
- **Volatile resync set.** `session-volatile-resync.ts` takes `activeBucketKeys: string[]` and returns `activeSessionIDs: string[]`; `refreshVolatileAfterResync` batch-refreshes inbox/todo/dag for the active session plus every board pane instead of only one.

The `KanbanPanel` component lives in `packages/app/src/components/kanban/` (panel, model, pane, layout subdirectories), wired through `builtin-navigation.tsx`, `app.tsx` (route + boot gate), `mobile-drawer.tsx`, a new `kanban.main` semantic icon token, and static i18n descriptors extracted into en/zh-CN/pseudo catalogs.

## Alternatives considered

- **Nested `SDKProvider`+`SyncProvider`+`DataProvider` per pane (directory-layout pattern)** — rejected on evidence: `SyncProvider.onCleanup` calls `releaseScopeState`, deleting the shared scope store; multiple panes in one scope would tear each other's store down and unmounting would delete a store the session page still uses. The board must go through the globalSync layer, reusing the sidebar prefetch pattern.
- **Server-side board aggregation endpoint** — rejected: events already broadcast per scope and the frontend can compose the view; a new route would add OpenAPI/SDK regeneration cost and be no fresher than the existing stream.
- **Reusing the whole session page component** — rejected: it is coupled to the route scope, the full composer, and turn-trim machinery; the board needs only the shared message components plus a minimal text input.
- **Turning `activeBucketKey` into an array directly** — rejected: `session-volatile-resync` and other consumers depend on the single-active semantic; a separate protected set is backward compatible.

## Consequences

- Users can monitor several sessions' streaming output on one screen, with per-pane follow toggles and persistent layout/pin preferences; a session in the board is protected from LRU eviction and survives reconnect volatile resync.
- The change is confined to `packages/app` (plus the shared icon registry in `packages/ui`); server, SDK, and protocol are untouched, so no migration or compatibility shim is required.
- Memory stays bounded: the board reuses the existing 15-bucket LRU cap (up to 6 panes + the active session fit comfortably), panes unprotect on unmount, and each pane renders only the loaded window tail.
- Cost: the board composer is intentionally minimal (plain text via `session.input`, no attachments/slash commands); permission responses and session management still happen in the full session page, and a board pane's history window is the same bounded viewport as the session page, not the full transcript.
