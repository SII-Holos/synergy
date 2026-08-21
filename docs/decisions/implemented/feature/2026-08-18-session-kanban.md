# Decision Record: Session Kanban board — multi-session live stream view

Status: implemented

## Problem

Users run several sessions concurrently (long-running evals, scheduled inspections, channel-backed agents, Blueprint loops) and need to watch them at a glance. The Web app only offered one session at a time; checking N sessions meant N page switches, and nothing aggregated "which sessions are running or waiting for me" across scopes. A board view that renders multiple sessions' live message streams on one screen would close that gap without changing how sessions are stored or streamed.

## Decision

Add a **Kanban** board page (`/kanban`) to the Web app, reachable from a fixed sidebar entry (order 15, between Agenda at 10 and Library at 20) and the mobile drawer. It renders live session panes in two switchable layouts (grid, focus+rail). Each pane has a follow toggle and a composer that posts plain-text input to the session via `session.input` (agent/model fall back to the session's last used values server-side), so the board is a live control surface rather than a read-only monitor. The pane set follows a mixed policy: pinned sessions (persisted via `Persist.global`) always occupy the leading slots; leftover pinned keys whose session vanished become removable "unavailable" placeholders; the remaining slots fill with every other visible session in sidebar recent order (most recently active first), so the board mirrors the sidebar and unread/idle sessions appear too. Layout, per-pane follow toggles, and the pinned set persist in localStorage, and the board capacity follows the active layout (grid: columns × rows; focus: the board cap).

The board is a pure frontend view-layer feature. It reuses the existing global event stream and per-Scope stores (`globalSync.ensureScopeState`/`peekScopeState`), the layout nav lists (`recentEntries`/`rootNavEntries`/`projectNavEntries`) as the session index, and the `messagePage` loader pattern already proven by sidebar prefetch. Each pane wraps the shared UI message components (`SessionTurn`/`MailboxMessage`/`CommandResultOutput`) in its own `DataProvider` scoped to the target store, with an independent `createAutoScroll` follow toggle. No server, SDK, protocol, or persistence-schema change was made.

One sync-layer generalization supports it:

- **Volatile resync set.** `session-volatile-resync.ts` takes the single `activeBucketKey` and returns `activeSessionIDs: string[]`; `refreshVolatileAfterResync` batch-refreshes inbox/todo/dag for the active session (the board dropped its per-pane volatile refresh along with the LRU protection). Board panes receive no LRU eviction protection: they enter the normal load path when the board is mounted (touching their message bucket) and refill from the loader after eviction, so memory stays bounded by the same 15-bucket cap as the rest of the app. A global eviction-version signal re-triggers the board's pane sync when a visible pane's bucket is evicted, so the pane refetches instead of sitting on a stale loading shell.

The `KanbanPanel` component lives in `packages/app/src/components/kanban/` (panel, model, pane, layout subdirectories), wired through `builtin-navigation.tsx`, `app.tsx` (route + boot gate), `mobile-drawer.tsx`, a new `kanban.main` semantic icon token, and static i18n descriptors extracted into en/zh-CN/pseudo catalogs.

Board preferences persist in `packages/app/src/components/kanban/model/preferences.ts` (`layout`, `pinned`, `gridCols`, `gridRows`, per-pane `follow`): the grid layout splits the board into a user-set columns × rows matrix (1–4 columns × 1–3 rows, at most 12 panes) whose rows divide the viewport height evenly (`grid-template-rows: repeat(N, minmax(0, 1fr))`), with overflow panes landing on fixed-height implicit rows. Sessions can be pinned by dragging a session row from the sidebar onto the board (custom `application/x-synergy-session` data-transfer MIME in `packages/app/src/utils/session-drag.ts`) or via the Add-session picker. Panes render turns with the same display settings as the session page — activity display mode and compact reasoning resolve from the global config instead of a board-local minimal preset. Each pane hosts a full composer — agent picker, permission selector, orchestration-mode menu (Default/Plan/Lattice/Boss), and a status bar — backed by scope-scoped `createSynergyClient` calls without nesting SDK/Sync providers (see Alternatives).

## Alternatives considered

- **Nested `SDKProvider`+`SyncProvider`+`DataProvider` per pane (directory-layout pattern)** — rejected on evidence: `SyncProvider.onCleanup` calls `releaseScopeState`, deleting the shared scope store; multiple panes in one scope would tear each other's store down and unmounting would delete a store the session page still uses. The board must go through the globalSync layer, reusing the sidebar prefetch pattern.
- **Server-side board aggregation endpoint** — rejected: events already broadcast per scope and the frontend can compose the view; a new route would add OpenAPI/SDK regeneration cost and be no fresher than the existing stream.
- **Reusing the whole session page component** — rejected: it is coupled to the route scope, the full composer, and turn-trim machinery; the board needs only the shared message components plus a minimal text input.
- **Turning `activeBucketKey` into an array directly** — rejected: `session-volatile-resync` and other consumers depend on the single-active semantic, and protecting every board pane from eviction would re-introduce the unbounded-memory problem the 15-bucket LRU cap exists to solve.

## Consequences

- Users can monitor several sessions' streaming output on one screen, with per-pane follow toggles and persistent layout/pin preferences; board panes join the normal message-bucket LRU (loaded on mount, refilled after eviction) and survive reconnect volatile resync.
- The change is confined to `packages/app` (plus the shared icon registry in `packages/ui`); server, SDK, and protocol are untouched, so no migration or compatibility shim is required.
- Memory stays bounded: the board reuses the existing 15-bucket LRU cap (up to 12 grid panes plus the active session stay within it), and each pane renders only the loaded window tail.
- Cost: the board composer mirrors the session surface for agent/permission/workflow selection and sends plain text via `session.input` (no attachments/slash commands); a board pane's history window is the same bounded viewport as the session page, not the full transcript.
