# Frontend Data Sync

## Purpose

The Web application maintains reactive projections of server-owned state. Initial and explicit loads come from generated SDK requests; ongoing changes arrive through one global event connection and are routed into global or Scope-local stores.

The sync layer optimizes identity stability, reconnect recovery, streaming cost, and bounded memory. It is not a complete normalized entity database: some feature resources remain component-owned and must refetch after reconnect.

## Connection Model

`GlobalSDKProvider` opens one WebSocket to:

```text
/global/event/ws?stream=projection
```

The server sends envelopes containing:

```ts
{
  scopeID: string | null
  payload: Event
}
```

`scopeID` routes the event to its owning Scope; `null` identifies Runtime-wide events and `home` is the Home Scope. A session executing in a worktree keeps its owning Scope ID. Connection identity separates events and persisted client state from different Runtime endpoints.

The connection:

- pings every 20 seconds while the page is visible;
- stops pinging while the page is hidden (the server keeps the transport alive
  with its own 30-second heartbeat and Bun `idleTimeout: 0`, so a hidden tab cannot be dropped for silence);
- probes immediately with one ping when the page becomes visible again, closing
  the socket after three missed pongs so a dead connection is detected quickly;
- flushes any events queued while hidden as soon as the page becomes visible,
  so the foreground applies the backlog immediately instead of waiting for the next 1 s cadence tick;
- reconnects with jittered exponential delay from 1 to 30 seconds;
- ignores server heartbeat frames as transport liveness only.

The server owns event subscription and socket lifetime together. A dropped send, send exception, explicit subscription removal, or sustained streaming backpressure closes the affected socket so the client can reconnect and replay or resync. Connected acknowledgements, pongs, and server heartbeats use the same subscription registry as broadcasts; a ping on an unregistered socket closes it instead of reporting healthy transport. Transient control-frame backpressure does not advance the streaming eviction threshold. Failure diagnostics record the send outcome and transport mode without event contents.

Incoming events are batched on an approximately 16 ms cadence while visible. Unsequenced streaming updates are coalesced by identity before the Solid batch is applied; sequenced state events retain every sequence. While the page is hidden the cadence relaxes to 1 second and streaming `message.part.delta` frames are merged per part into a single pending delta (the ≤1 s server checkpoint converges the authoritative part), keeping the background main-thread cost bounded without dropping sequenced state events. The event queue is capped; when the cap is reached it flushes early so watermarks keep advancing.

## Store Shape

The sync layer has:

- one global store for paths, project list, providers, provider auth, global Agenda data, and the session runtime indexes;
- one lazily created store per home/project Scope;
- message arrays keyed by session ID (window, not full transcript);
- `messageWindow` metadata keyed by session ID (cursor, hasMore, total, mode, pendingLatest, tailMissingLatest);
- `latestContextMessage` keyed by session ID, holding the latest eligible assistant snapshot independently of the visible message window;
- part arrays keyed by message ID;
- per-session buckets for diffs, todo, DAG, inbox, and Plan Blueprint offers;
- per-Scope collections for sessions, agents, commands, config, MCP, LSP, VCS, and Agenda.

**Session runtime indexes are global.** Session status and the pending permission and question requests live in the global store keyed by session ID, and the visible Cortex task list in the same store keyed by task ID (it is Runtime-wide, not Scope-scoped), rather than in a per-Scope store, because surfaces that render many sessions at once (sidebar rows, the mobile drawer, the Kanban board, the status bar) read them across every Scope while a Scope store is released as soon as its last retention lease ends. A status may now be `paused`, carrying the reason, an optional description, and `since`; whether a session is working is decided by the shared classifier in `apps/web/src/utils/session-status.ts`, where `paused` is explicitly **not** working. The index holds only non-idle statuses: an `idle` event deletes the key, while a `paused` status is a real non-idle status and stays in the index. `GET /global/session/status` (`global.session.statuses`) is the cross-Scope snapshot, and it merges each Scope's recoverable statuses — the only way a status reaches a client without an event, because no producer publishes the derived status on the event bus. Its operationId deliberately does not read `global.session.status`: the SDK generator groups methods by the first two operationId segments and ignores a leading `global`, so that name collides with the scoped `session.status` and the generator silently drops or retargets the scoped method. The global indexes follow the same post-stamp discipline as the Scope buckets through one `GlobalRuntimeWriteTracker`: only keys with an event write after the response stamp override the snapshot, and a `session.updated` carrying `info.working` fills a status the index has no entry for, while a real status event always wins.

A busy status carries optional structured `activity` with phase, phase start time, root identity and active tool count. The loop lease and bound root fence updates; actual file preparation, Worker admission, model content, scheduler and finalization boundaries publish transitions. The sequenced status event, global snapshot and session `working` projection carry the same value, including when the client converts `working` back to runtime status. Process headers and runtime hints translate this metadata through the shared UI projection without inspecting lazy Part buckets or rendering diagnostic descriptions as stage labels.

**Session identity is projected, not stored.** A row's identity — Blueprint binding and phase, workspace type, workflow kind and activity, parent, category — travels on the navigation entry (`SessionNavEntry`), which is paginated, persisted, and refreshed by `session.updated`. That projection is what keeps a row's glyph intact while its Scope store is gone.

**Diff data sources.** Two separate diff stores exist:

- **Turn-level diffs** are stored in `message[n].summary.diffs` on the user message and reach the frontend through the existing `message.updated` state event. No new event, store bucket, or route was needed — the normal message reconcile path carries them.
- **Session-level diffs** live in the `session_diff` bucket and aggregate all turn diffs for the Review workbench panel. They are loaded on demand through `sync.session.diff()` and never fetched implicitly.

Global bootstrap starts health, capabilities, Core preferences/providers, paths, Scope catalog and provider authentication concurrently. Scope bootstrap limits concurrent instance requests to two. Workspace records in the Core snapshot are batch-read only for its visible Session IDs and the current binding; unrelated catalog bodies do not gate navigation. Each instance uses the generated `scope.bootstrapCore()` snapshot for navigation, minimal Agent summaries, current models, necessary preferences and connection state. The snapshot is reconciled in one Solid batch before the store becomes `partial`; permissions and questions keep their independent owner routes, and the store becomes `complete` after those requests settle. The server stamps the response sequence before reading snapshot fields, so a same-epoch response whose seq trails an event already applied was read before that event happened. Events stay authoritative only for the keys they wrote after the stamp: the write trackers record the last sequenced event write per key — the per-Scope trackers for the session list plus archive tombstones and pending requests, and the global tracker for session status and Cortex tasks plus whole-bucket Cortex replacements — and snapshot application overlays only those post-stamp keys onto the snapshot — every other key converges to the snapshot, including its deletions, so state left stale by a missed event (an idle that never arrived) cannot survive a fail-open resync while a live busy status (which drives the sidebar running icon) is preserved. The per-Scope store registry is reactive: consumers that first observed no store for a Scope ID re-run when it is created or evicted.

## Request Interaction State

`SessionDecisionProvider` lives below SDK/Sync in the directory owner and above the replaceable Session page. `SessionDecisionHost` owns presentation, accepts an inline native outlet and supplies a host fallback when a replacement page provides none. Both card actions and `DataProvider` permission replies use the same coordinator; `DataProvider` forwards the captured session/request identity even while reconnect temporarily empties the pending index. Pending facts stay in `GlobalSync` and are read through `SessionDataView`.

Request identity is the tuple of server URL, Scope ID, session ID, request ID and kind. Each submission captures its client, identity and immutable answers or permission reply. Local operation tokens reject late results after settlement, eviction or disposal. The coordinator exposes idle, pending, error, unknown and settled states: pending locks duplicates, error retry checks authoritative pending state first, and unknown offers a read-only status check without resending. Server confirmation immediately removes the request from presentation; histories remain server-owned.

Question drafts use an independent v1 Persist workspace entry keyed by server and Scope, then session/request identity. They contain only current question position, selected labels, custom text and option/custom source. Restoration validates selections and position against the live question definitions. Submission locks, permission choices and countdown windows are transient. A storage read failure leaves an in-memory answering path without overwriting unread durable drafts.

`GlobalSync.questionSnapshot` confirms a successful full pending-question read after existing event merging. The read token carries Scope ID, runtime generation and request revision; disconnect/reset invalidates the generation and a newer started read in the same Scope supersedes older responses. Empty loading buckets and failed or obsolete reads do not publish confirmation. If reconnect cleared the runtime index, a successful incremental replay reloads pending lists when this generation has no confirmed snapshot; an empty event journal cannot rebuild existing requests. The decision owner removes drafts only after an explicit question terminal event, successful reply or its own Scope's accepted current-generation snapshot. Permission and question list routes read one Scope, so each snapshot replaces only that Scope's global-index slice. Source-Scope metadata and per-Scope sequencing trackers protect unrelated pending sessions and post-snapshot terminal events across different epochs. Pending data stays in the existing global indexes; there is no independent pending cache.

Progress visibility follows the resolved canonical session activity, pending decisions, loaded session metadata and transport connection. Completion of Todo/DAG entries supplies counts, not execution-end evidence. Initially idle sessions suppress receipts; observed execution changing to confirmed idle schedules the receipt removal, including failures. Waiting, paused and disconnected states cancel removal. Retained hidden DAG presentation uses inert, aria-hidden and frozen without allocating a second graph or changing volatile state ownership.

## Reconcile, Do Not Replace

Existing store objects and list entries are updated with Solid's `reconcile()`.

This is an invariant for event handlers and refetches:

- use a stable entity key such as `id` or `file` for collections;
- reconcile an existing session, message, part, permission, question, Agenda item, or other entity;
- use `produce()` only for insertion, removal, a narrow leaf mutation, or coordinated bucket deletion;
- do not replace a whole object merely because one event carries a complete serialized value.

Reconciliation applies only to the same entity identity. A single-entity projection such as `latestContextMessage` may share its object with the message window. When its message ID changes, replace the projection pointer through `produce()`; reconciling at that object root mutates the previous transcript entity, including its ID. Same-ID updates continue to reconcile in place.

Preserving unchanged identities keeps memos and components that read unrelated leaves from invalidating on every timestamp, status, or streaming update.

Streaming delta application is even narrower: it appends only to the `text` leaf of the matching text/reasoning part.

## Message Window and Cursor Pagination

The frontend maintains a per-session bounded message window backed by cursor-based pagination via `GET /session/:sessionID/timeline/page` (generated SDK `session.timelinePage`). The unbounded `messages()` API and `/session/:sessionID/message` route remain available for runtime loops, export, and preview consumers.

### Window state

Each session stores `MessageWindowMetadata` keyed by session ID in the store:

```ts
type MessageWindowMetadata = {
  nextCursor: string | null
  hasMore: boolean
  total: number
  mode: "latest" | "history"
  pendingLatest: boolean
  pendingLatestIds: string[]
  tailMissingLatest: boolean
}
```

The `messages` array in the store contains only the visible window messages, not the full transcript. `tailMissingLatest` records that a history prepend cap-evicted newest overflow, so the bounded window's tail no longer reaches the true latest messages. Latest page applies and latest-mode reconciles clear it; history prepends, in-place reconciles, and removals preserve it.

### Page size and cap

- Timeline requests use at most 100 headers and a 256 KiB decoded summary budget. Part pages have independent cursors, the same count and byte ceilings, and a target Part window for search or hash location. The store primary-message cap is 500.
- The store's `DEFAULT_CAP` of 500 applies to primary messages in latest loads and to the full retained set during history prepends. Latest mode additionally retains dependency roots referenced by those primary messages, so the visible window may exceed 500 entries without losing a turn anchor.

The durable display projection is prepared lazily. Session migration initializes a pending display state, while a timeline request reads only the canonical order markers needed for its requested window (bounded to 256 candidates) and materializes those summaries before querying the display index. This keeps first navigation independent of the total historical message count; explicit maintenance preparation remains available for a complete projection, and history search materializes any matching message headers before returning results. Storage admission failures use a retryable `503 StorageServiceError` with a bounded `Retry-After` hint, and the Web timeline loaders retry that error with cancellation-aware backoff.

### Latest mode

Initial load and reconnect recovery use latest mode (`mode: "latest"`). Incoming `message.updated` events only reconcile into the visible window when both `messages[sessionID]` and `messageWindow[sessionID]` are present — the session message bucket must be loaded. When either is absent (session never loaded or bucket evicted), the event advances resource freshness and the `latestContextMessage` projection but does not create a message window from empty state. The window is instead established by `timelinePage` when the user enters the session.

- If the session message bucket is loaded and the message already exists, the window updates in place.
- If the message is new and the window is in latest mode, it is inserted and the primary window is capped by dropping the oldest unreferenced messages.
- Any root referenced through `rootID` by a retained primary message stays in the window outside the cap. Snapshot `referencedRoots` and live event reconciliation preserve the same dependency-root closure so non-root user guidance always retains its `SessionTurn` anchor.
- Dropped message IDs release bodies, Part summaries, cursors, content versions and their cache leases from the store.

The window cursor (`nextCursor`) is recorded from each page response so older pages can be loaded later.

### Latest Context projection

Context status and workbench consumers read `sync.session.latestContextMessage(sessionID)` rather than deriving latest usage from the bounded `messages` viewport. The projection is owned by sync and has three states: a missing key (`undefined`) is uninitialized and permits a temporary fallback to an already-loaded eligible viewport message, `null` means an authoritative latest page contained no eligible assistant and forbids that fallback, and a message is the latest ordered context-usage record.

Eligible usage snapshots are assistant messages with `includeInContext !== false` and either structured `contextUsage` or a non-zero legacy input, output, or reasoning token total. A completed included compaction assistant is instead an ordered invalidation barrier: it sorts after pre-compaction usage but does not expose the compaction call's own tokens as conversation context usage. Consumers show usage as unknown until the next ordinary assistant snapshot. Canonical chronology is `time.created`, then `id`; a later ineligible zero-usage assistant does not erase an earlier eligible snapshot.

Context Usage category enrichment is asynchronous and fail-open. The terminal assistant update can arrive first with provider token totals only; a later ordinary `message.updated` event atomically adds only the category snapshot when the isolated estimator succeeds. If estimation is unavailable, the totals-only assistant remains authoritative and the frontend does not wait or synthesize a breakdown.

Every no-cursor latest page apply seeds the projection, including normal session loads, navigation prefetch, reconnect/recovery refreshes, return-to-latest, stale-cursor recovery, and compaction reloads. Cursor/history pages never replace it. Latest page loads and background prefetches capture a `message` resource request token before the request. A latest response may replace the visible window only if no newer message event, authoritative part checkpoint/removal, history prepend, or optimistic local message write invalidated that token while it was in flight. Background prefetches evaluate per-message part freshness before accepting the resource response, so a rejected page cannot advance its watermark. They additionally run only when no message window exists, so they populate an initially empty bucket rather than displace a loaded conversation.

Latest-page loading treats a freshness rejection as a superseded attempt, not a successful empty apply. The session message loader retries with new request tokens, pausing between attempts with a doubling backoff (100 ms up to 400 ms, at most four attempts), and reports the bucket ready only after an apply succeeds. A first view with no previously successful snapshot restarts the whole attempt window once after an 800 ms pause before surfacing failure, so a session streaming while the user switches to it still loads instead of stranding a blank transcript behind the retry button. Exhausted supersession remains a visible load error while preserving any previously successful snapshot.

Kanban applies the same accepted latest-page plan atomically: messages, parts, window metadata, and latest Context projection. Readiness uses the real message-window snapshot marker, including for an empty page. Updating messages alone cannot establish a loaded window. Loader tests use a real Solid store so missing metadata cannot be hidden by an independent test flag.

Each asynchronous latest-page request also captures a per-session projection revision. A newer latest-page request or a persisted `message.updated`/`message.removed` event advances that revision. After resource freshness accepts a page, the projection revision independently prevents an older response from overwriting newer event-driven Context usage. Complete persisted `message.updated` events reduce the projection inside the accepted event write even while history mode suppresses insertion into `messages`. Removing the projected message invalidates the key without a per-event request; the next authoritative latest page restores it.

### History transitions

The active session watches the server-owned rollback identity and redo validity as well as connection and reconnect recovery state. A rewind or redo identity change requests a `history-transition` sync, forcing the authoritative effective latest message window even when redo is unavailable. Applying that window replaces old branch messages and removes their part buckets through the existing message-page reconciliation path. The latest rollback summary supports immediate local filtering, including known dropped IDs outside the loaded cut boundary, but cannot represent every earlier rollback. Ordinary session metadata updates do not trigger this history reload.

### History mode

When the user requests older messages via "Load earlier", the frontend switches to history mode (`mode: "history"`):

- The existing window messages are preserved; older fetched messages are prepended.
- The combined set is capped at 500 by dropping the newest overflow (not the just-loaded older messages). If the cap cuts inside a logical root turn, the whole partial trailing turn is dropped so the kept tail is complete and stays at or under the cap.
- A subsequent `message.updated` event for a message not already in the window sets `pendingLatest: true` instead of inserting it. The metadata retains the exact unseen IDs in `pendingLatestIds`, so duplicate updates do not add state and a matching `message.removed` clears only that notice without decrementing the window total for a message it never counted. A prepend that cap-evicts messages filters any of their IDs out of `pendingLatestIds`: they are no longer unseen arrivals but are gone from the window, so the tail gap is tracked by `tailMissingLatest` instead.
- `total` excludes those suppressed live arrivals while history mode remains active. Older-page totals are reduced by the count of remaining `pendingLatestIds` so suppressed live arrivals do not inflate the displayed total; returning to latest replaces the metadata with the server total and clears the pending IDs.

History page responses are intentionally applied without snapshot-version ordering because they extend the existing window rather than replace it. Applying a history page invalidates the `message` resource revision so a concurrent latest-page response cannot subsequently overwrite the prepended window. Explicit older-page, location, return-to-latest and refresh actions are serialized per Session; identical pending actions share their result. They wait for an already active page read and then use the current window, so a click cannot silently join an unrelated latest refresh or disappear behind a loading guard. Recovery waits for accepted navigation before choosing the window to refresh. The history controls expose the queued navigation as loading, and disposed Scope owners cannot dispatch queued work.

### Return to latest

"Return to latest" refetches `messagePage()` without a cursor, resetting `mode` to `"latest"` and clearing `pendingLatest`. The UI force-scrolls to the bottom. Stale-cursor errors during `loadMore` also automatically trigger this recovery: the frontend catches `SessionMessagePageCursorStaleError` and refetches latest. Bounded-window bottom recovery reuses the same path whenever its predicate holds at the local bottom: the user is not scrolled up, the window is in history mode with a tail gap (`tailMissingLatest`) or unseen arrivals pending, and no history load is in flight. Each session starts disarmed; engagement — starting a history load, or scrolling up after the page observed a not-scrolled-up evaluation — arms the trigger, so navigating onto a retained history window never discards its stored view. Once armed, the predicate is evaluated as a level and fires once per gap episode with hysteresis: a fire stays consumed until the predicate is observed false again and stays frozen while the recovery request runs, so a failed attempt never retries on its own, while a history load finishing under an already-parked cursor or streamed arrivals parking into an engaged history window still recover; gap-less history keeps the previous scroll behavior.

### Scroll anchor

A pure history prepend passes an exact suffix identity transition to Virtua so measured heights move with their rows and the virtualizer compensates the viewport. The viewport publishes the DOM owner of its accepted reading anchor; the outer virtualizer retains that owner's row while the same viewport restores its offset. Native scrolling updates this owner throughout the movement, and following, rebinding or disposal releases it. The session page does not schedule a second DOM-based prepend correction; the nonvirtual viewport uses the same existing reading owner. The session page's `turnStart`, which controls how many user turns are visible in the scroller, is reset to 0 only after a successful load so failed loads do not disturb the turn pagination state.

While pinned at the bottom of a latest-mode conversation, the session page keeps the rendered turn tree bounded: when new turns push the visible count past `MAX_RENDERED_TURNS` (40), `turnStart` advances so the oldest turns are trimmed from the DOM. Trimming only happens when the user is at the bottom; history, scrolled-up, and user-scrolled states keep the full window (the "Load earlier" button restores trimmed turns). Because the scroller disables native `overflow-anchor`, the viewport is re-pinned to the bottom after the trim layout settles. A focused/hash-linked message that falls outside the trimmed window clears its active marker so scrollSpy falls back to the newest message.

## Initial and Explicit Loads

The generated SDK owns internal HTTP calls. Scope-specific clients carry a canonical `scopeID`. Directory hints are used only for explicit discovery.

Rollback feedback suppression reads the server-owned `session.rollbackAck` from the synchronized session record. When the rollback dialog is presented, the client immediately records a page-local pending key to prevent duplicate effects while `session.rollbackAck()` and the resulting `session.updated` event complete. The pending key is only a round-trip barrier: it is not persisted in browser storage, and a new rollback ID remains eligible even if an older key or acknowledgment exists.

Scope initialization uses `GET /scope/bootstrap` (`scope.bootstrap()`). The server reads the aggregated fields concurrently. Provider, agent, and config are required; failure in any of them fails the request. Optional field failures keep the response usable and are reported by field in `_errors`. Home snapshots omit project-only LSP and VCS fields.

Session detail loading is split by concern:

- session metadata loads independently; metadata and diff completions validate the captured Scope store, resource generation and cancellation lifetime before applying state;
- messages load through `session.messagePage()` — an initial latest page of 100 for the rendered bound, 200 for history prepends — stored in a bounded window capped at 500;
- parts are sorted and reconciled under their owning message;
- inbox, todo, and DAG refresh together through `session.volatileBatch()`, while diff and questions retain separate refresh paths and pending permissions load only for the viewed session through the `sessionID` filter on `/permission`;

An accepted local root remains visible through a client-only optimistic marker when the queued response assigns a different canonical message ID. Acceptance atomically rekeys the message, its part bucket, and any history-mode pending ID instead of deleting the rendered root. Authoritative events and latest pages replace the marked message when the same ID materializes; until then, canonical-only actions and new-session transition completion remain blocked, while Inbox timeline cards still deduplicate by rendered message ID.

Ordinary new-session input uses the generated `session.input()` method. A queued response is a durable partial Inbox mutation rather than a complete Inbox snapshot: the client validates the response against the captured Inbox request token and response watermark, reconciles the returned item into the Scope store, then invalidates the resource version so the complete `session.inbox.updated` event at the same sequence remains eligible. This makes the accepted prompt visible even when the event connection is delayed or disconnected. The mutation upsert is skipped when the item's pre-allocated message ID is already materialized — present as a canonical (non-optimistic) message in the loaded window, or recorded as an unseen arrival in the window's `pendingLatestIds` (history mode records canonical arrivals there instead of inserting them into the messages array). The backend consumes inbox items peek-then-commit, so a materialized message proves consumption and re-inserting the item would resurrect a ghost row. The same proof prunes ghosts reactively: a canonical user `message.updated` for an item's message ID removes that item from the store's Inbox bucket, healing a dropped or reordered `session.inbox.updated`. Because materialization can precede the durable inbox commit by a crash window, the prune also schedules one authoritative inbox refresh, so an item still retryable on disk reappears instead of staying hidden behind an empty local bucket.

The new-session transition records the accepted item's message ID and remains blocking after the HTTP response. It releases preparation through its exit lifecycle once the corresponding visible canonical root message is present in the message window, without claiming task completion. If the pending Inbox item disappears before the root is observed, the active session forces one messages-and-volatile refresh to converge cross-resource event ordering. Inbox items whose message IDs are already materialized are omitted from the pending timeline.

`POST /session/batch/volatile` accepts at most 50 deduplicated session IDs and returns an in-band state or error for each requested session. Missing, archived, and cross-Scope sessions do not expose state. After reconnect resync, the client invalidates volatile freshness for every retained session, clears inactive cached inbox/todo/DAG buckets, and batch-refreshes only the actively viewed session. An inactive session reloads through its normal detail path when viewed instead of being eagerly fetched during reconnect.

Frontend code should not introduce raw `fetch()` for ordinary Synergy routes. Add route OpenAPI metadata, regenerate the SDK, and use the generated client. Streams, browser-native file/blob flows, and external URLs remain valid raw transport cases.

## State Event Sequencing

Each Scope runtime owns a fresh event `epoch` and a monotonic `seq` counter.

- Every non-streaming Bus event receives the current epoch and next contiguous sequence number.
- Streaming events are marked `streaming` and receive no sequence number.
- State events are retained in a per-Scope replay journal.
- The default journal retains at most 4,096 entries and five minutes of history.
- Disposing and recreating a Scope runtime creates a new epoch.

The Web client tracks the highest observed `{ epoch, seq }` per Scope. Duplicate and older sequence values do not move the watermark. An epoch change requires a full Scope resync.

## Replay and Resync

On reconnect, the client requests:

```text
GET /event/replay?since=<seq>&epoch=<epoch>
```

The route always returns a JSON result:

```ts
{
  status: "ok"
  epoch: string
  seq: number
  events: SequencedEvent[]
}
```

or:

```ts
{
  status: "reset"
  epoch: string
  seq: number
}
```

`reset` is returned when:

- the client's epoch belongs to another runtime;
- the client is ahead of the current sequence;
- the required journal prefix has expired or been pruned.

For `ok`, the frontend applies replayed events through the same event reducer and advances the Scope watermark. For `reset` or request failure, it refetches the aggregated Scope bootstrap snapshot and the independent permission/question collections. Volatile freshness is invalidated for all retained sessions, inactive volatile buckets are cleared, and only the actively viewed session's inbox/todo/DAG state is batch-refetched.

When replay returns `reset`, the frontend also calls `resourceFreshness.resetScope()` before refetching. This advances the Scope generation, invalidates in-flight resource requests, and clears stale per-resource versions so the resync snapshots can establish fresh baselines.

Resources outside the normalized store, including BlueprintLoop feature state, observe the global `reconnectVersion`, which advances when reconnect recovery starts so they can refetch promptly.

Active session message/part snapshots observe a separate completed generation for their owning Scope. The Scope generation advances only after replay or full resync succeeds; failed recovery, stale completion, and a recovery that finishes after Scope release do not publish it. The session page waits for that generation rather than starting durable snapshot requests at the raw connectivity transition. Because tool-part updates are published as unsequenced streaming events, reconnect replay alone cannot restore a missed tool card. Once recovery completes, `sync.session.sync()` force-reloads the viewed session's durable message/part snapshot in addition to volatile collections.

Failed recovery does not strand the session page: a failed per-Scope recovery is retried with bounded exponential backoff (two seconds doubling to a thirty-second cap, at most six attempts). Retries run the generation-owning recovery path directly — never the aggregated resync request singleton — so a retry can neither suppress nor be suppressed by a concurrent global resync, and a late success still publishes the Scope generation and unblocks waiting session snapshots. Event-gap recovery failures arm the same retries, but a bare event-gap replay that repairs the store without publishing a generation does not cancel a pending retry; only a generation-owning success does. A successful generation-owning recovery resets the retry budget; releasing the Scope store or disposing the sync provider cancels its pending retries.

Reconnect replay starts from the watermark retained before the disconnect. Live gap recovery likewise retains the pre-gap watermark as `replayFrom`; it neither advances the Scope watermark nor applies the triggering event until replay or full resync completes. An epoch change also holds the prior watermark and requires authoritative full resync. Duplicate recovery requests for the same Scope are coalesced while replay is pending. Session snapshot requests capture the exact completed Scope generation when they begin; a newer or stronger request queues behind an insufficient in-flight request, and only an accepted latest message snapshot advances that session's generation watermark.

## Resource-Level Snapshot Freshness

The sync layer applies a freshness gate to DAG, Todo, Inbox, and Message snapshots and live events. Each resource is scoped to `(scopeKey, sessionID, resource)`.

### Response headers

Scoped snapshot responses expose:

- `x-synergy-seq`
- `x-synergy-epoch`

This includes ordinary scoped GET snapshots and the POST volatile batch response. The server captures the epoch and sequence number before reading the snapshot, so the value is a conservative lower bound for that response. The Web client reads both headers via `readSyncVersion()` and uses them in the freshness checks below.

A response is unversioned when either header is absent or the epoch/sequence values are invalid.

### Request tokens

Every snapshot request captures a `SyncResourceRequest` token:

- `generation` — a Scope-level monotonic counter. A new Scope epoch or `releaseScope` advances the generation, invalidating all in-flight requests for that Scope.
- `revision` — a per-resource counter that increments on every accepted event or snapshot and on local invalidation. A revision mismatch means the resource was written between request capture and response arrival.

### Response acceptance

`acceptResponse()` checks the captured request before delegating every accepted response to `acceptSnapshot()`:

1. **Generation match.** If the current Scope generation differs from the request generation, the response is rejected — a Scope epoch switch or release occurred between request and response.

1. **Revision check.** If the resource revision changed while the request was in flight, an unversioned response is rejected. A versioned response may continue only when the resource has a known current version to compare against.

1. **Snapshot version guard.** Responses that pass the request-token checks still go through the epoch and sequence checks below.

Partial mutation responses use `acceptMutationResponse()`. They pass the same generation, revision, epoch, and sequence validation as snapshots, then invalidate the resource version after applying their targeted update. This prevents stale in-flight snapshots from overwriting the local mutation without suppressing a complete state event carrying the same sequence.

### Local invalidation

Optimistic message insertion/removal, authoritative part checkpoints/removals for messages present in the loaded window, and history prepends call `invalidate()` for the session's `message` resource. Invalidation clears the stored resource version and advances its revision without changing the Scope epoch. Requests captured before that local write are therefore rejected, including versioned responses, because no current resource version remains to prove that they include the local mutation.

Streaming `message.part.delta` frames do not invalidate resource freshness. They remain unsequenced, append-only projections whose next full checkpoint converges authoritative part state.

Message-page requests also capture a local per-message part revision map. Applied delta, checkpoint, and removal events advance only the affected message revision. A mutation applied to an existing local bucket makes an otherwise accepted snapshot preserve that live bucket. A checkpoint or removal ignored because its parent message is outside the loaded window marks that message as requiring a newer snapshot; an in-flight page retries only when its returned effective window contains the affected message, so unrelated orphan events do not supersede the whole session page. When the window is loaded in latest mode, such a drop additionally schedules one debounced, budget-bounded repair reload per session (2 s debounce, at most 3 attempts per 60 s window) through the shared session-window reload loader, so a terminal checkpoint dropped while its message raced the window converges without a manual refresh; drops for sessions with no loaded window stay cold-load-on-next-view. Repair checks latest mode again before requesting and applying a page, preserves diff/inbox state, and joins pending reloads. Compaction cancels queued repairs and can supersede an in-flight repair. Scope release and message-bucket eviction retire these local request tokens, cancel pending repairs, and release in-flight reloads.

Back-to-back ignored checkpoints for the same message with no capture in between coalesce into one mark — every in-flight request predates the original mark and already retries, while a capture in between re-arms the mark so that request still sees the newer checkpoint — which bounds the retry area during streaming bursts.

### Snapshot version guard

`acceptSnapshot()` enforces:

- **Retired epochs are rejected.** An epoch that has been superseded cannot overwrite current state.
- **Snapshots cannot switch an established Scope epoch.** `prepareSnapshotScope()` rejects a snapshot whose epoch differs from the current Scope epoch when one exists. Events are authoritative for epoch transitions; a snapshot may establish only the initial epoch when no Scope version has been set.
- **Older snapshots are rejected.** A snapshot with `seq < current.seq` for the same resource and epoch is stale and discarded. Equal `seq` is accepted because the server stamps the sequence before reading.
- **Unversioned responses fail open conditionally.** An unversioned response is accepted when no intervening same-resource write occurred (revision unchanged). When an event updated the resource in flight, the response is rejected because it cannot prove it is newer. An accepted unversioned snapshot clears the stored resource version, so later ordering starts from the next valid version.

### Scope-level event pre-filter

Before any event reaches `applyEvent()`, the global listener calls `acceptScopeEvent(scopeKey, version)`. This applies to every incoming event, not only resource-gated updates:

- events from retired epochs are dropped without changing the watermark or triggering replay;
- an event from a new epoch retires the old epoch, advances the Scope generation, invalidates in-flight resource requests, clears per-resource versions, and establishes the new epoch floor;
- unversioned events, including streaming deltas, pass through without changing Scope freshness state.

This pre-filter runs before watermark observation and before the resource-specific `acceptEvent()` checks.

### Event acceptance

Live events (`todo.updated`, `dag.updated`, `session.inbox.updated`, `message.updated`, and `message.removed`) pass through `acceptEvent()` for their owning resource:

- **Epoch advance.** An event with a new epoch retires the old epoch, advances the Scope generation (invalidating in-flight snapshot requests), clears all resource versions for that Scope, and establishes the new epoch.
- **Ordered only.** Within the same epoch, an event with `seq <= current.seq` for that resource is a duplicate and discarded.
- **Unversioned events** clear the resource version rather than preserving a comparison that can no longer be proven. A later unversioned snapshot may still fail open when its request was captured after that event and no same-resource write occurred in flight.
- Every accepted event bumps the resource revision.

### Resource scope

Per-resource snapshot/event ordering applies to `dag`, `todo`, `inbox`, and `message`. Message replacement snapshots include latest page loads, background prefetches, and post-compaction page loads. Message part checkpoints/removals for messages present in the loaded window and local optimistic writes invalidate concurrent message requests without becoming sequenced resource events; streaming deltas remain outside resource freshness. Part mutations outside the loaded window use the per-message freshness decision above instead of globally invalidating unrelated pages. All incoming events still pass through the Scope-level epoch pre-filter.

## Streaming Delta Protocol

The in-process Bus publishes a full `message.part.updated` object for every text/reasoning increment. The client wire encoder rewrites that stream for clients that opt into `stream=delta`.

For each streaming part, the wire sends:

- a full `message.part.updated` checkpoint for the first increment;
- compact `message.part.delta` frames between checkpoints;
- another full checkpoint at most once per second;
- a full terminal update when streaming ends.

A checkpoint and delta are mutually exclusive for one increment, preventing double append.

Delta-bearing text/reasoning checkpoints preserve accumulated text when the incoming text is a strict prefix. No-delta writes, including intentional truncations and final checkpoints, replace the text authoritatively. All part-update events carry the streaming transport classification, so the delta field distinguishes incremental writes.

Streaming frames remain unsequenced because they are convergent rather than journaled state. If a delta arrives before its part exists locally, the frontend ignores it; the next full checkpoint creates or corrects the authoritative part.

Encoder checkpoint state is transport-local. The global WebSocket delta clients share one encoder because they receive the same frames; each SSE connection owns another encoder. A global encoder shared across independent transports would let one consumer's checkpoint timing corrupt another's convergence.

### Incremental presentation

The reconciled `part.text` string remains the authoritative frontend snapshot. Active text and reasoning renderers keep an offset into that snapshot and pass only the appended suffix through the display projection and the streaming Markdown parser. They do not compare, transform, or replay the accumulated prefix on each update, and they do not create a separate character-rate backlog between the event stream and the renderer.

The display projection preserves leading-trim behavior without rewriting model-authored Markdown, including absolute paths, across chunk boundaries. A part identity change, source shrink, or transition to terminal state rebuilds from the authoritative snapshot once. Terminal state comes only from the part's explicit end marker or the owning message's completion marker; coarse session status and the presence of a later timeline part do not terminate a renderer that can still receive deltas. The terminal Mark…

Streaming Markdown creates a fixed set of token elements through DOM APIs and rejects unsafe link and image URL protocols before setting attributes. Raw model HTML is never assigned to `innerHTML` during streaming. Automatic bottom-following is coalesced so content growth schedules at most one scroll operation per animation frame.

A session switch opens the fresh scroller at the top; the page pins it to the bottom through one re-armed init chain once the message window becomes ready. Pending admission keeps the viewport measurable but transparent, accessibility-hidden and inert; subtree opacity prevents explicitly visible virtual rows from exposing intermediate layout. A forced pin is a short follow contract: the auto-scroll hook stays active for a settle window (default 1000 ms), re-pins through late content growth (images, code highlighting), and extends the window per growth. While follow is inactive, content growth fires no scroll event, so the hook reports the bottom distance through `onMeasure` and consumers derive scrolled-up state from that measurement; the session page gates the reporting until its initial pin has consumed so partially laid-out content cannot flash the jump button, and remounting a scroller resets stale user-scrolled state. The native transcript remounts its subtree keyed by server URL, Scope and Session while the route, Composer and workbench keep their own lifetimes. Solid can mount the successor viewport before the swapped-out owner's cleanup runs: viewport releases therefore attribute the element they bound (`setScrollRef(undefined, el)` / `contentRef(undefined, el)`), and holders ignore a release whose element no longer owns the binding — an unattributed release from the stale owner would otherwise drop the successor's binding, leaving the new scroller at the top with a dead jump button.

While the page is hidden, per-part delta frames are merged into one pending delta per part in their original queue position; a full `message.part.updated` checkpoint for the same part clears an earlier pending delta in either visibility mode (the checkpoint is authoritative, so merged deltas never double-append). Deltas received after a checkpoint remain after that checkpoint, allowing it to create or update the part first. Visible pages keep per-delta application so token receive telemetry stays intact.

### Markdown terminal handoff

Conversation and process scroll owners declare `data-scroll-viewport="vertical"` on their native scroll element, including before content overflows. Streaming capture and terminal virtualization share one ancestor resolver: the nearest declared owner supplies the viewport. Only when the ancestor chain has no declared owner may its nearest ordinary native element with actual vertical overflow supply the viewport; otherwise Window owns it. A content-sized horizontal scroller's computed `overflow-y: auto` does not establish vertical viewport ownership.

The Markdown worker returns blocks with original UTF-16 source intervals and compact reading runs. Lexer consumption, CRLF preparation, indentation, code normalization and HTML character references retain original source positions. One generated document identity binds runs to sanitized DOM owners; authored HTML cannot grant itself text provenance. Code chrome and repeated table headers have no reading source, while media keeps an atomic source interval. Text and atomic elements share one reading-point resolver. Chunk targets bound divisible source content; Unicode graphemes remain whole, images remain atomic, and oversized indivisible inline metadata uses the existing source-preserving plain admission. Rendered HTML can exceed a source chunk target through syntax highlighting. The Markdown cache accounts for source, rendered HTML, code sources, reading runs and layout metadata within its byte budget.

At large terminal adoption the streaming owner captures the first visible content point as original source position plus viewport pixel offset, and measures canonical block sizes once. Both renderers resolve the same source point even when block splitting changes line wrapping. One synchronous layout transaction reserves the measured total height, replaces the stream DOM, mounts the virtualizer and releases the reservation in `finally`; native scroll position cannot clamp through an empty layout. Virtua accepts sizes through its ordinary resize action and reads the existing viewport offset at mount through the scroll and scroll-end actions, without starting a user-scrolling timer. After one hydration microtask, the same virtualizer accepts mounted content-box sizes, consumes estimate compensation and commits the captured content point once as a native idle position. No imperative measurement waiter survives adoption; real wheel, touch and keyboard input immediately take ownership. Identical-offset scroll delivery retains public scroll callbacks without changing the native scroll direction, so short range readers can still admit history. Selected text or focused descendants postpone replacement until their existing interaction protection releases.

Stream initialization and terminal measurement caches use the same width and font signature, including Markdown code font tokens and root font metrics. A changed signature rejects stored geometry; normal virtual measurement owns responsive reflow. Captured initialization contains only numeric geometry and source identity plus the signature, and releases with the stream owner. The terminal cache stores only signed virtual measurements. Neither retains DOM, parser, Solid owner or event callbacks.

Settled stream text appends into the existing Text run. Completed arrival spans merge adjacent runs and transfer source segments while preserving range endpoints. Only pending arrival spans retain animation state. Grapheme continuation keeps the final Unicode grapheme per Text node and segments that tail with the next suffix; it never segments the accumulated paragraph on each update. The streaming parser owns provenance in its text and pending buffers, including recursive pending-token replay. The rationale lives in [Markdown terminal reading](../decisions/implemented/bug-fix/2026-10-08-markdown-terminal-reading-and-stream-ownership.md).

## Server Part Write-Behind

Network streaming and disk persistence are separate optimizations.

`PartWriteBuffer` coalesces streaming text/reasoning persistence per part at a default 500 ms interval. It retains the caller's newest part value by reference and snapshots it once at flush, so successive deltas are priced incrementally instead of re-serializing the accumulated part.

- streaming increments defer disk writes;
- discrete tool/status changes write immediately;
- terminal writes cancel or supersede buffered values;
- `messagePage()` flushes pending writes for the requested session before reading its snapshot;
- loop finalization flushes every pending value;
- a turn ending in error or abort republishes each non-empty unfinished text/reasoning part as a full checkpoint before completing the message;
- buffer cancellation is used only when an immediate authoritative write will replace it.

This removes quadratic full-part disk writes while keeping snapshot reads and terminal frontend recovery aligned with the latest streamed content.

## Compaction Attempt Projection

Compaction assistants remain canonically hidden while running, but the shared timeline makes a narrow presentation exception: a hidden compaction assistant whose persisted `metadata.compactionAttempt.state` is `running` or `failed` projects as the compaction card. Raw streamed compaction text stays suppressed behind that card. The same message ID and timeline key remain mounted when the backend resolves the attempt: `committed` makes the message visible and adds the recovery part, while `failed` persists a visible terminal error on the existing message.

The processor's terminal message checkpoint does not end this presentation lifecycle. The compaction owner resolves `running` to `committed`, `failed`, or `empty`; failed attempts replace progress in place with the dedicated error presentation, while hidden empty attempts disappear. Ordinary `visible = false` messages never receive this exception.

Conversation body projection excludes `compaction` control-marker Parts, including historical summaries whose `render` hint is true. These markers establish compaction requests rather than display content; the owning message metadata and attempt still project the chronological process event. Filtering them cannot suppress a pending manual request or its assistant-owned replacement. See the [compaction status presentation decision](../decisions/implemented/feature/2026-10-05-compaction-status-text.md).

Attachment purpose counts and tool display classification come from canonical Part summaries. When an activity tool also has deliverables, the virtual projection retains one execution segment and a separately keyed attachment segment immediately after that invocation, both leasing the same Part. Closing the process removes only the execution segment. Hydrated projection applies the matching attachment selection and preserves original order; inspection evidence stays within its activity row. Neither projection requires eager tool-body hydration to decide placement.

## Compaction Swap

`session.compacted` means the visible effective message set changed at a summary boundary.

The compaction event is gated through `acceptEvent()` using both the session's `inbox` and `message` resource keys. A duplicate, older, or retired-epoch compaction event is discarded before any message swap or cleanup runs.

The frontend:

1. captures separate Inbox and Message request tokens, per-message part revisions, and a Context projection revision, then fetches the post-compaction messages via `session.messagePage()` while keeping the current timeline visible;
1. accepts the page through the same bounded-retry Message loader used by ordinary latest-page loads and recomputes the apply plan from the current store when an attempt succeeds;
1. applies one Solid batch that deletes stale parts and diff state, deletes inbox state only if no newer inbox event arrived while the fetch was in flight, and preserves live part buckets changed during the request;
1. reconciles the retained messages, unchanged authoritative parts, message window metadata, and latest Context projection atomically.

Fetch-before-swap prevents an empty timeline flash. Part buckets belonging to messages outside the new effective set must be released. The message window metadata (`nextCursor`, `hasMore`, `total`, `mode`, `pendingLatest`, `pendingLatestIds`, `tailMissingLatest`) is replaced atomically in the same batch. Newer Message state supersedes and retries the whole stale swap, newer Inbox state preserves only the inbox bucket, newer per-message part state preserves that live bucket, and a newer Context projection revision preserves the newer usage record.

## Message Bucket Eviction

Loaded message and part buckets are memory-bounded independently of session metadata.

- the global LRU spans Scope/session bucket keys;
- at most 30 session buckets are retained, covering the recently viewed working set;
- the actively viewed session is protected even if it is the oldest;
- board panes get no eviction protection: they enter the normal load path when the board is mounted (touching their bucket, which keeps them near the LRU head) and refill from the loader after eviction, so a board pane can never silently show a blanked timeline;
- eviction removes that session's message array, all parts owned by those messages, the session's `messageWindow` metadata, and its latest Context projection;
- revisiting an evicted session reloads it through normal message page sync.

Session lists, inbox, todo, and other non-message state are not evicted by this policy. Session runtime state is not subject to it either: status, the pending permission/question requests, and the visible Cortex task list live in the global indexes, so message-bucket eviction never touches them.

## Composer Intent

Composer model selection has strict one-way layering:

1. user draft selection
2. durable server model/thinking selection, otherwise last root message
3. global/application fallback

Lower layers never write into higher layers. Existing-session model and thinking changes use `session.setModelSelection`, with a per-session serialized mutation queue and expected revision. Accepted responses provide the baseline for the next edit without waiting for an event; pending generations prevent an older response or failure from replacing newer intent. Save failures retain an explicit retry action. Reload and other clients read the canonical session state.

Agent and workflow selections follow the same principle: server session fields are durable defaults, while unsent composer intent remains local until the user performs an action that explicitly persists it.

Settings and the session toolbar use the same thinking choice component. Default means provider default, Off requires a supported disable option, and concrete variants come from the model catalog for that Scope. Settings edits initialize future sessions; session choices do not write global settings. The new-session draft remains local until creation, when its effective choice is saved before submission. Existing-session submissions omit model/thinking copies so they cannot overwrite a newer saved selection. The toolbar distinguishes saving, next-request pending, restricted tool-turn pending and failed saves.

## Composer Interaction State

The active Web Composer owns one in-memory document controller. A snapshot contains a monotonic revision, editable text, UTF-16 selection offsets, optional Session identity, and normal/shell mode. File pills and other non-editable nodes remain in the controller's private DOM mapping and edits crossing them are rejected. Completion, decoration, and edit APIs share this revision boundary, so an asynchronous result cannot mutate a newer draft.

Composer snapshots, settled-draft notifications, selected-text snapshots, completion, and decorations are transient interaction state. They are not server snapshots, Scope store buckets, persisted records, global events, replay items, or reconnect-recovery inputs, and their text is not written to diagnostic logs. Scope/Session navigation and component or plugin-generation disposal cancel active callbacks instead of replaying them after remount.

## Invariants

- One global event WebSocket multiplexes events by owning Scope ID.
- State events are sequenced per Scope epoch; streaming events are unsequenced.
- Replay returns `ok` or `reset` JSON and full resync is the fail-open recovery. Live gaps replay from the retained pre-gap watermark and do not apply the triggering event before recovery.
- SyncProvider holds a Scope lease and registers message-loader disposal before returning. The last lease moves the Scope into the inactive LRU; overlapping transition owners and visible Kanban panes share it. Departing board panes cancel their requests before releasing their Scope lease. At most eight unleased Scopes remain in LRU order, including recently viewed Scopes, so opening a global panel preserves sidebar status and warm message windows. Bootstrap, resync, replay, and session-list responses apply only to their original live store instance. Scope eviction clears queued bootstrap work, replay tracking, refresh timers, message-LRU membership, and all begun context projections. Timer and projection cleanup use exact Scope identity. See the [transition lifecycle decision](../decisions/implemented/bug-fix/2026-09-07-transition-lifecycle-retention.md).
- Scope bootstrap is one aggregated generated-SDK snapshot plus independent permission/question requests that apply to the global indexes; reconnect invalidates volatile freshness for all retained sessions, clears inactive volatile buckets, and batch-refreshes only the viewed session. A snapshot response applies with per-key post-stamp overlay: only keys whose last sequenced event write postdates the response stamp keep their event value (tracked with archive tombstones; epoch changes reset tracking), while every other key converges to the snapshot including its deletions. The per-Scope store registry is reactive so consumers that observed no store re-run on creation and eviction.
- Bounded domain event queues use explicit recovery signals rather than silent loss. For File workspace watcher overflow, `file.watcher.updated` carries `resync: true`, and the File context reloads its root, expanded directories, and active document.
- Every event passes the Scope epoch pre-filter; DAG, Todo, Inbox, and Message additionally use resource-level snapshot/event freshness (generation + revision tokens and version comparison). Optimistic message writes and authoritative part mutations for messages present in the loaded window invalidate concurrent Message requests; streaming deltas do not. Unversioned snapshots are accepted only when no intervening same-resource write occurred.
- Store updates reconcile existing leaves and identities.
- Superseded latest-message snapshots retry with doubling backoff before a bucket is marked ready, and a first view with no snapshot restarts the attempt window once; per-message part decisions apply unchanged buckets, preserve newer live buckets, and retry only pages that contain an ignored out-of-window mutation, whose marks coalesce until a capture re-arms them.
- Streaming deltas converge through periodic checkpoints and a final full checkpoint on normal completion, error, or abort.
- Active text rendering processes appended suffixes rather than rescanning accumulated snapshots.
- Session-scoped snapshot reads flush pending part write-behind first, and disk write-behind never delays discrete or terminal persistence.
- Compaction fetches before swapping the visible message set and uses the same supersession recovery as ordinary latest loads.
- The active session survives message-bucket eviction.
- Composer fallback resolution never writes upward into user intent.
- The frontend message window is a viewport, not the full transcript. `messages()` and `messagePage()` serve different consumers.
- Latest mode keeps the newest messages and evicts oldest; history mode preserves the oldest loaded primary slice and caps newest overflow without discarding a turn's retained prefix. Part-row virtualization keeps partial turns readable without increasing the cap.
- `tailMissingLatest` marks a history window whose newest overflow was cap-evicted; history prepends, reconciles, and removals preserve it, latest page applies clear it, and bottom-return recovery re-fetches latest only in history mode when it is set or unseen arrivals are pending and no history load is in flight. Explicit history loading, search and hash locations hold recovery until forward scrolling or an explicit return releases them; short target windows and provisional virtual-row heights cannot discard the location.
- Only a loaded session message bucket — both `messages[sessionID]` and `messageWindow[sessionID]` present — forms an authoritative visible window. Incoming `message.updated` events for an unloaded or evicted session advance resource freshness and the `latestContextMessage` projection but must not create a message window from empty state. The window is established by `timelinePage` when the user enters the session.
- `messageWindow` metadata and messages are evicted together by the message-bucket LRU.
- Latest Context usage is sync-owned and independent of history viewport suppression; authoritative latest pages seed it and bucket eviction removes it.
- The event queue relaxes to a 1 s cadence and merges streaming deltas per part
  while the page is hidden; sequenced state events are never dropped, and a hidden page does not ping the server (the server's own heartbeat keeps the transport alive). Visible pages return to the 16 ms cadence and probe the connection immediately.
- Single-message reconcile inserts into the sorted window incrementally
  (binary-search insertion point) instead of re-merging and re-sorting the whole window; the window order and eviction semantics stay canonical.
- The rendered turn tree is bounded: while pinned at the bottom in latest mode,
  `turnStart` advances so at most `MAX_RENDERED_TURNS` user turns are mounted; the trim re-pins the scroller after layout settles.
- The initial session pin re-arms when history readiness flips, so a cancelled init chain reruns on the next ready edge; a forced pin opens a settle window during which resize growth re-pins, and growth outside follow reports the bottom distance instead of relying on scroll events.
- Part-row presentation adds the root message explicitly to its reply projection, so root-only history and search windows retain their user body.
- Each `SessionTurn` consumes a precomputed projection of its turn members
  instead of rescanning the message window, so a new message invalidates only the projection memo rather than every rendered turn.
- `BrowserViewEffects` keeps its handled-callID set bounded to the timeline
  window, releasing callIDs that were trimmed or switched away.
- Model readiness is derived from the global provider snapshot, not from the startup health probe. `resolveModelReadiness` reads only `connected`, `runtimeAvailability`, and `authHealth`, and an app-wide readiness surface renders inside the synchronized shell so it observes a populated snapshot before it can render. The `GET /global/health` probe — including `modelReady` and its bounded provider wait — is a startup and diagnostic signal for the CLI and daemon consumers, never a UI readiness source, and no readiness consumer may cache it.

## Tool content retention

Tool review tabs persist session/message/part identity and a selected path. The mounted panel loads that message through the Scope-aware generated SDK and aborts obsolete requests. It does not persist tool payloads in layout state or create a session-wide eager fetch. File links use the existing workspace-file loading and eviction owner. String interning has bounded admission maps as well as a bounded retained-value map; promotion removes the admission reference. Rendering and cache capacities follow the [bounded tool rendering decision](../decisions/implemented/bug-fix/2026-09-07-bound-tool-rendering-memory.md).

The shared message stream uses one stable message/part projection for all display modes. Consecutive ordinary tools are bounded by canonical content, Scope, approval, receipt and renderer transitions. Fold state changes visibility without replacing the turn tree. The App-owned session layout retains explicit choices through the optional `conversation.activityView` service; shared UI receives a controlled reader/writer and retains a local fallback for independent consumers. Balanced completion closes untouched disclosures only while the viewport follows the bottom.

The existing viewport scroll owner retains a bounded DOM reading anchor inside a stable message/part row. Detached layout changes compensate paragraph displacement through resize observation, including workspace reflow, disclosure animation and media loading. Restore callbacks validate the Session and scroller owner and release on replacement or unmount. Explicit return to latest clears the historical anchor and resumes bottom following.

Execution details use one lazy Workbench tab per Session. Persisted selection carries server, Scope, Session and a discriminated tool invocation or process event identity without payloads. Tool selection retains message, part and call IDs; Agent delivery and compaction retain their owning message ID. The panel reads canonical loaded parts and fetches only selected evidence through the generated SDK. Agent results require the exact captured Cortex task identity, including when a child Session has been reused; viewing never acknowledges a notification. Abort and full-identity checks reject obsolete results; closing releases the result renderer and subscriptions. Selection advances only through a person's row action. The selected running call consumes scoped activity invalidations; output scroll follows until the reader scrolls away. File results use captured operation content, never a fresh resource read disguised as history. Parameter diagnostics remain a secondary view. The optional `ResourceOpenController.openActivityDetail` and `isActivityDetailSelected` cover both selection kinds; `openToolActivity` and `isToolActivitySelected` retain tool integration.

Root execution states use `SessionConversation`'s local request baseline and keyed store through the generated `session.turnExecution` method. Preparation readiness and canonical Session presence admit an initial latest-64-root read; closing admission clears states, aborts and fences requests, and reopening establishes a fresh baseline. Scoped `session.execution.updated` events dirty only matching loaded canonical roots; membership changes dirty added roots and prune evicted states. Same-turn invalidations coalesce in a microtask, and one in-flight request per server, Scope, client and Session drains later dirties after settlement. Identity epochs and per-root versions reject obsolete responses, including re-admitted roots. Each response applies accepted per-root reconciliations or failure clears inside one Solid batch so virtual process and row projections observe a coherent window. Permission transitions and the existing GlobalSync reconnect generation conservatively dirty the retained window; lifecycle revision fallback dirties only its latest root. Failures clear only current requested states and never self-retry. Display aliases retain row identity without becoming request or execution-cache keys. `session.tool.activity` updates only the selected invocation. Message deltas and leaf reconciliation stay canonical. No per-frame REST polling or independent session event connection is added. See [Targeted execution invalidation](../decisions/implemented/bug-fix/2026-10-07-targeted-conversation-execution-invalidation.md).

Before a Session ID exists, `SessionTransition` owns a preparation lease keyed by the connection and Scope. A revision guards its provisional message identity, prompt, current activity, cleanup and atomic handoff to the real Session entry. This transient presentation is released when canonical input bodies and matching execution evidence are ready. Model selection still finishes before durable input admission; the existing optimistic reconciliation and input-progress observer take over when input is accepted. A lost receipt is reconciled through scoped `session.inputStatus` before rollback. Durable admission keeps the message and its recovery owner; unavailable evidence remains a receipt check rather than failed admission, while a missing record allows ordinary draft recovery.

Library navigation and search controls remain outside content Suspense boundaries. Usage reads return the last computed snapshot without refreshing history; an explicit sync streams incremental refresh progress, and concurrent refreshes share a job. A new-session handoff polls `session.inputStatus` serially and consumes coalescible `session.input.progress` events while waiting for its canonical message. Authoritative input progress replaces the current activity phase; elapsed time never establishes success or failure. Network loss remains reconnecting; authoritative parked or paused input exposes retry, and cancellation exposes dismissal. Switching sessions or retry attempts aborts the old observer and ignores late responses. Adjacent sessions are not automatically prefetched during route transitions; explicit hover prefetch remains available.

## Historical upgrade status

The status bar polls the generated `storage.upgradeStatus` method while historical owners remain unresolved. This progress snapshot is independent of session event watermarks and never triggers per-event data reloads. New work remains available; selecting old history waits for that owner’s migration and recovery. The separate paginated upgrade catalog exposes unresolved identities without rescanning legacy files.

## Persisted client identity

Persisted project selection, drafts and other Scope state use the owning connection and stable Scope ID. Home has no directory. A nullable local binding disables filesystem surfaces without preventing history, managed attachments or conversation state. Legacy directory references are resolved against the connection’s Scope catalog at the persistence boundary; an exact match wins, a unique alias may resolve, and ambiguous or missing paths stay unresolved. They cannot become Home or select an arbitrary project. Cross-connection drag payloads are rejected before applying their Scope or session IDs.

## Historical preparation

The Session route gates canonical message loading and actions on the generated storage preparation API. Once mounted, the route shell and composer stay mounted across preparation; an unready conversation hides canonical history and may display only its captured local submission. Its component-owned controller polls only while pending/preparing, backs off while hidden and ignores disposed navigation responses. It does not synthesize message events or replace Scope watermarks. Returning to the workspace leaves durable preparation running. The status bar distinguishes historical convergence from independent backup completion and exposes background pause/resume; quarantined data remains blocked for repair.

The native default page is rendered outside the Session-bound plugin page surface, so acquiring a Session ID does not rebuild its component tree. Replacement plugin pages retain the existing bound-service lifecycle and release the previous Session's services when identity changes. Once admitted, the Composer stays mounted through transient draft hydration and becomes inert until its current draft is ready.

An active preparation attempt reports preparing and omits the previous attempt's error so polling continues through a background retry. Once the attempt settles, readiness or the persisted failure becomes visible. Quarantine remains blocked even when an attempt is still draining.

Navigation clears a completion notice only after the owner reports ready. Concurrent clears share an in-flight guard through optimistic rollback so a rejected write cannot feed back into the reactive effect as an unbounded retry. Readiness replies from a previous server cannot mutate the current server or its navigation state.

Project-folder recovery captures the connection, Scope, project configuration, explicit draft selection and confirmed binding revisions. Derived binding generations and defaults can refresh without changing the user's intent. Mutations run sequentially through the generated SDK; uncertain replies reconcile against validated directory and catalog reads before retry. Successful folders remain restored after a later failure. Navigation or changed configuration cancels remaining work and prevents stale intent updates. Completion refreshes directory and Worktree projections once alongside the existing `workspace.updated` reconciliation, retaining Composer and trigger nodes during refresh. Retained projections belong to their captured client, connection and Scope; a pending load for another owner cannot display the previous owner's Worktrees.

## Workspace file contexts

File state is separate from Scope session and event state. File requests, event filters, cached documents, directory trees, explorer preferences, editor models and preview links are keyed by server, Scope, Workspace ID and binding generation. Session selection uses its canonical Workspace projection; a null or unavailable session binding never falls back to the Scope directory.

File tabs retain their opening Workspace descriptor and encode its identity into the resource ID. An old generation remains explicit and can fail on the server after a rebind. Legacy tabs without an owner require reopening from the intended Workspace. File contexts snapshot the descriptor before asynchronous work, discard results after disposal, and retain at most sixteen inactive/current contexts plus contexts held by mounted file panels. Scope disposal aborts outstanding file work and releases editor models.

## Demand-driven resources and content

Consecutive reasoning fragments share the first Part's disclosure identity across render chunks. Summary identities establish these anchors without hydrating offscreen bodies; each mounted chunk renders its own paragraphs and shares the same expansion preference. Only the first chunk owns the trigger, and each chunk's detail region has a distinct DOM ID. Message changes, prose, tools and unloaded spans end reasoning continuity. Historical display preparation is invalidated through the Session migration runner and rebuilds lazily from original Parts.

Virtua row measurement observers publish the latest measurement per target in one animation-frame batch outside ResizeObserver delivery. Zero-size notifications from targets without layout boxes are discarded during delivery so hiding and restoring a virtualized list preserves its measured row cache and reading anchor; visible zero-size targets remain measurable. Unobserving a row removes its queued measurement; disposal cancels queued publication. Process viewport chrome reads scroll geometry before applying overflow state, and the outer conversation writes its process height limit only when that limit changes. Settled disclosures do not measure layout. Manual process and batch disclosure animate height and opacity on their outer wrappers; their virtualized content keeps its natural geometry inside the clipping transition. Automatic logical process exits retain opacity motion with stable allocated height. A manual parent entrance expires after its first mounted transition settles or that row mount disposes, so later virtual mounts do not replay it. Motion bindings release their element and animation listener with the specific conditional mount; unchanged visibility does not restart motion on unrelated row updates. Rapid reversal continues from the current painted geometry and opacity. The pinned virtualizer patch and its entrypoint coverage are documented in [Dependency patches](../../patches/README.md#virtua-solid-resize-delivery).

`scope.bootstrapCore` establishes navigation, minimal Agent summaries, current model selection, necessary preferences and connection state. Core statuses cover only the navigation page and preserve live status precedence over persisted pauses; complete status APIs retain their cross-Scope recovery scan. `Server-Timing` separates Core configuration, Agent, navigation, status, provider and Workspace reads. Full configuration, complete Agent definitions, commands and panel resources are lazy. Command lists contain summaries without templates; template getters run only during execution in the selected Workspace, so opening Home cannot execute filesystem, MCP or skill templates. Provider catalogs share their immutable base across Scopes; configured overlays compose independently, versioned pages are bounded and historical model IDs resolve in batches. A late page cannot enter a newer catalog.

Worktree inventory does not compute dirty state or directory size. Worktree details and Git status have local loading boundaries; the transcript and Composer do not wait for them. Direct file children use file capability without allocating an Environment. Shared inventory and status requests cache for five seconds with their generation and original event stamp. A consumer abort releases only its subscription; the last consumer cancels the underlying task.

Projection transport replaces inactive Part bodies with `message.part.summary`. Body interests identify Scope, Session, Message, Part and subscription generation; checkpoints establish epoch, sequence and content version before deltas. Version gaps, hidden-page return and reconnect renew interests. Projection replay retains each state sequence without sending inactive bodies. An obsolete unsequenced subscription response loses its body but retains a Web-local discovery hint. The hint admits a missing Part summary without replacing an existing summary or body; the mounted row obtains current content through its normal lease. Discovery hints coalesce separately from current summaries so they cannot suppress a pending authoritative update. Sequenced summaries retain their normal processing. See [Part discovery after subscription renewal](../decisions/implemented/bug-fix/2026-10-04-preserve-part-discovery-after-subscription-renewal.md). Checkpoint errors permit explicit retry.

Conversation body rows use Virtua overscan four and keep the existing scrolling element. Assistant text remains one renderable Part per row. Ordinary user content shares a message group, combining attachments and short authored text within budgets of 128 KiB of text, six text Parts and 32 total Parts; large text and paged spans retain separate leased rows. The message end owns timestamp and actions, and message-keyed presentation retains source, text and attachment disclosure across row remounts. User group identities survive optimistic reconciliation and existing chunk starts survive history prepends. Adjacent process tools and reasoning use render chunks of at most six Parts and 128 KiB of declared content, with existing chunk starts retained across prepends. Logical activity disclosure spans these chunks and assistant messages until process prose or an unloaded gap. Each root has one process entrance and one completion footer. Disclosure, active execution and content-presence metadata are shared across its rows; closing a process releases its bodies after bounded mounted-row exit motion while retaining the final answer. Automatic completion waits for the final assistant terminal marker. Automatic settlement preserves a process being read or selected. Pure history prepends shift the virtualizer measurement cache by the exact retained row suffix. The viewport publishes its accepted reading-anchor owner, and the outer virtualizer maps it to at most one retained row. Native scrolling keeps that identity current through keyboard paging and inertia. Following, viewport rebinding and disposal release the owner. This same reading owner restores geometry; the virtualizer does not classify input separately. Resize delivery accepts the restored viewport offset even when restoration performs no write because Virtua already compensated it. Its later scroll receipt cannot replace the accepted reading owner with a newly visible historical row. Lazy body replacement does not replay an earlier anchor. Recovery refreshes retained history headers through bounded pages anchored at the retained tail and fetches latest Context independently. Accepted Part summaries and bodies stay mounted and budgeted while their page is stale. Client page metadata records each accepted bounded interval independently, including disjoint target windows. Revalidation refreshes those intervals atomically, preserves live writes received during the read and removes unchanged missing Parts only within the refreshed intervals. Stale accepted pages retain readiness; initial missing pages and failed refreshes use the existing load and retry surfaces. Body subscriptions renew without discarding accepted content even when the summary version is unchanged. A combined snapshot keeps the first response watermarks so later pages cannot give older headers a newer version. Message and Part location obtain the target window before scrolling. Focus and non-collapsed selection keep mounted rows until released. Expansion preferences live outside rows. Measured-layout snapshots are captured before virtualizer ref release and contain cloned plain data, keyed by server, Scope, Session and presentation identity. The access-order cache admits at most 128 entries and 4 MiB, rejects a different width or row sequence, invalidates publication after a mounted width change and retains no store, service or DOM references. Message/body cache leases share a 128 MiB byte budget across Scopes, evict inactive content first, and protect active consumers even when those consumers exceed the soft budget. Scope eviction clears its exact content-budget prefix together with content caches and asynchronous owners, so eviction callbacks cannot retain released stores. Latest Context remains independent of the mounted transcript.

Virtualized admission preserves native DOM state as well as keyed identity. When old and new mounted arrays retain their common nodes in the same order, the DOM reconciler removes only obsolete nodes and inserts only new nodes; common nodes remain continuously connected. A retained focus or selection owner cannot be temporarily replaced and reinserted. Chronological DOM order and bounded retention remain intact; actual reordering uses the normal keyed reconciliation path. The pinned framework correction and upgrade checks live in [dependency patches](../../patches/README.md).

Initial latest loads and navigation prefetch share bounded viewport preparation: timeline headers, the latest root and three tail-message summary pages, and at most sixteen renderable text or attachment bodies totaling 128 KiB of declared content. Resource watermarks and per-message snapshot freshness gate their atomic publication; bodies must match their summary version and identity and participate in the shared content budget. Failed or oversized bodies retain the normal lazy lease path. Storage-ready Sessions share a thirty-entry, server-keyed access-order cache owned by the global SDK; connection loss clears it. Native conversation admission waits for mounted leases to settle, including visible failures, and for connected Scope recovery, initial latest/hash scroll and two layout frames before exposing the mounted viewport. Admission latches for the immutable transcript owner, preserving streaming updates and captured first-send handoff. Cold admission fades once for the shared base duration; reduced motion settles immediately and retained recovery does not hide or animate accepted content again. While following latest, content resize commits its bottom pin during resize delivery rather than exposing the resized document for another frame; explicit reading still cancels following. The rationale lives in [Session switch admission](../decisions/implemented/bug-fix/2026-10-07-session-switch-display-admission.md).

Part arrivals use an App-owned foreground lease scoped to server, Scope and Session. Only accepted live renderable summary additions after the message and latest Part baselines are ready grant a receipt. Discovery, snapshots, lazy bodies and replay do not grant receipts. Session changes release pending receipts; a stale lease cannot release its successor. Pending receipts expire after two seconds and retain at most 64 Parts; consumed identities retain at most 512 Parts. Visible row consumers take a receipt once for a 180ms opacity fade, with no parent entrance or height animation. Reduced motion settles immediately. Streaming suffix effects remain owned by real body increments.

Grouped reasoning retains individual Part targets inside each chunk. Reading restoration uses the visible fragment and falls back to its leading disclosure across chunks. Already aligned positions do not issue another virtual scroll request, because imperative requests retry during later measurements. Pending layout correction protects the saved target from passive scroll events until the virtual row cache matches its measured size and the next frame commits; new reading input cancels that pending correction.

Expanded logical process groups own bounded inner scroll windows and virtualizers with overscan two. Pending process body rows reserve one compact activity line per summary Part, and their shared estimator initializes the inner virtualizer. Ordinary user messages and final answers retain their own measured geometry. Empty pending boxes cannot collapse the demand window and repeatedly admit and cancel the same body reads. Accepted content continues through normal measurement, while visible failures settle readiness and keep explicit retry. See [Process disclosure preparation and motion](../decisions/implemented/bug-fix/2026-10-08-process-disclosure-preparation-and-motion.md). Their height is capped at 320px, 240px in narrow columns and 45% of the conversation viewport. Local reading begins before user disclosure mutations even at natural height and restores Part or paragraph anchors through each virtual size commit, prepend and reopening. The outer list retains mounted selection and focus owners plus at most one current local reading owner; outer reading gestures, a new owner or explicit location release that extra retention. The App restores through the owning virtualizer with the concrete Part offset inside its row; shared UI uses native offset compensation. Explicit movement owns its next native displacement, cancels an older layout restoration and captures the new reading anchor. This intent does not expire at the first animation frame because native default scrolling can arrive later. Only direct child mount/unmount mutations on the precise inner virtualizer root are excluded from body-layout restoration; nested and mixed body changes remain protected. A removed paragraph falls back to its reasoning trigger and insufficient range clamps naturally. Scrollbar space stays stable; 24px edge overlays add no height or width. ResizeObserver measures and restores reading. Accepted live revisions advance an already following active process; explicit Latest or End, or downward user movement to its end, establishes following. An already following active process also pins late body growth synchronously during measurement. Explicit Latest or End remains local and follows later layout hydration. Agent delivery and compaction stay in canonical chronological groups without adding operations; event-first groups use their message identities before Parts load. Metadata and footer segments cannot duplicate these events, and their bodies remain lazy inspector reads. The rationale lives in [Bounded process windows](../decisions/implemented/feature/2026-10-04-bounded-process-windows-and-system-event-details.md) and [Process stability](../decisions/implemented/bug-fix/2026-10-05-conversation-process-stability.md).

Part body leases share version-conflict recovery in the Scope content cache. Only `SessionDisplayConflict` and a superseded body version trigger recovery; network, permission and unrelated errors remain explicit failures. Recovery obtains an anchored Part summary page through the generated SDK, merges summaries by identity and preserves loaded history and its cursors. Per-message page requests serialize; a forced refresh follows an older pending request, and queued recoveries reuse a page that advanced their target versions. Body reads allow four attempts with 100/200/400 ms pauses; a Part without accepted content receives one additional attempt window after 800 ms. Advancing versions consume the same budget until success or explicit retry. Exhaustion stops requests and exposes a content-sync retry without changing execution status. The last accepted body stays visible and counted in the shared memory budget until replacement or eviction. Releasing the last reader, removing a Part or disposing its Scope cancels recovery and fences late writes. Message rows track failures by Part and current lease, clear only the corresponding successful state, guard diagnostic fields as strings and expose a localized retry action separately from the reason. A removed retry control returns focus to its message row without scrolling or taking focus from another control. The rationale lives in [Conversation content recovery](../decisions/implemented/bug-fix/2026-10-04-conversation-content-recovery.md).

Terminal Markdown parses and highlights in a lazy worker with cancellation and content-version fences. The 16 MiB Markdown cache contains source, HTML, document blocks and measured layout. Large Markdown documents mount visible blocks only; very large indivisible list items, cells and unsupported blocks render bounded escaped source. Active selections and focus defer replacement until interaction ends. Streaming Markdown retains its incremental renderer. Worker output passes through the existing sanitizer when mounted; trusted generated math markers preserve copying while authored markers are removed.

Full-history search, copy and export read canonical effective history or its independently maintained text projection; they do not infer scope from mounted DOM or cached Parts. Search returns stable Message and Part identities. Default search includes visible user and assistant text; reasoning and tools are opt-in. Short queries scan bounded pages and continue through cursors, including empty result pages. Conversation copy and text download capture the selected Session before awaiting a shared canonical read; the server reads headers, rollback visibility and original Parts in one maintenance-reader snapshot. Portable transcript archives retain raw evidence for round-trip recovery.

Browser telemetry admits one upload at a time, spaces navigation-triggered uploads by at least one second and respects server retry delays with bounded exponential backoff. Collector replacement fences pending upload completion by generation, preventing another Runtime from receiving queued metrics from the previous collector.

## Execution details

Workbench owns the product execution read model in `packages/workbench/src/execution`. Harness supplies canonical Rollout snapshots, retained usage records, session lineage and evidence content through public exports. The scoped SDK operations are `session.executionSummary`, `session.executionTrajectory`, `session.executionNode`, `session.executionContent` and the content `Sections`, `Search` and `Download` methods. Queries validate Scope, selected root round and executor membership before returning evidence. Node IDs encode saved identity; filter-bound cursors page 100 nodes by default, up to 500. Existing trajectory calls default to `records`; `process` groups actual calls and purposes on the server and supplies separate upserts/removals. Child round attribution follows persisted ancestry; insufficient lineage remains unassigned. Grouped auxiliary nodes retain real individual calls and never combine request bodies.

`rollout.updated` carries committed evidence metadata, including tool and process state; notification failure does not invalidate a committed recording. Workbench combines it with `usage.updated`, message and session events, coalesces updates and publishes `execution.updated` with a summary, retained round summaries, changed nodes and removals. Active read models are limited by a runtime-scoped LRU; streamed changes update cached metadata instead of reading full history for every event. An evidence revision gap triggers a new canonical snapshot before accounting, preserving call/attempt relationships. Events received during snapshot loading and message hydration are buffered until a stable merge, including newly created children. A transient projection failure keeps the subscribed root available for recovery on subsequent events. Raw messages and artifact bodies remain lazy inspector reads.

The Web execution provider supplements open and reconnect transitions with a fresh summary. The trajectory overlays versioned events received during snapshot loading; `previousRevision` detects omitted updates and triggers recovery around the reading window. Reconnect starts a new revision baseline because server-local counters may reset. Existing rows remain visible while recovery loads. A shared list retains at most 500 nodes including expanded branches, renders a bounded viewport and tracks the first visible identity plus its relative offset. History updates reconcile existing rows and count unseen events without admitting them or moving the reading anchor. Latest or explicit paging admits rows. Closing task details disposes trajectory subscriptions and requests; the quick summary does not preload bodies.

Quick Task details' Workspace, Environment, scheduled activity and removed Inbox reads use explicit initial snapshots and latest-value reads so neither first loads nor refreshes activate the Session page's Suspense fallback. Resource snapshots validate their owning client and selected resource; keyed Session owners retain Inbox operations. Closing, leaving a subview or clearing its resource target aborts pending reads while retaining the displayed subview through the Popover exit animation. The next open resets navigation and transfers focus to the revealed entry when the exiting portal remains mounted. Deferred Popover focus restoration verifies the opener remains collapsed before returning focus. See [Task detail loading and dismissal](../decisions/implemented/bug-fix/2026-10-04-task-detail-loading-and-dismissal.md).

Evidence ranges use a bounded chunk-manifest index in Harness. Content versions bind owner, artifact identity, recorded byte count and checksum; requests cannot switch evidence mid-read. Workbench indexes saved JSON structure and searches the entire recorded object without retaining its body. Client raw pages and derived rows share an 8MiB budget. The default reader opens the whole saved field directly; section indexing remains an available read API rather than a prerequisite for reading. Each evidence block owns its copy, search and download operation; smaller complete JSON may be indented for display, while copy and download retain the original recorded bytes. Continuous scrolling loads UTF-8-safe ranges and restores the visible row. Copy/download stream the same version, validate length and checksum and abort on node change, closure or explicit cancellation. Incomplete recordings and invalid JSON remain explicit; a failed verification never becomes complete clipboard data.

Latest main-task context and cumulative accounting have separate provenance. Category distribution is returned only when the saved assistant context snapshot matches the selected latest request's model and input-token total. Missing categories, request bodies or historical timings are not reconstructed. Durable root-run terminal state determines completion, while an active descendant keeps the task visibly running; elapsed-time growth independently follows root-run intervals.

## Resource Workspace state

Layout version 2 persists resource references, tab order, activity, open/fullscreen preference, preferred dimensions and finite output visibility through the existing layout migration entry. Notes use Runtime, Scope and note identity; files retain Workspace and binding generation; browser tabs use Runtime, canonical server ownerKey and page identity. Shell visibility does not own resource lifetime. Domain controllers retain document baselines, save queues, drafts and reading/selection positions. Late requests and close callbacks validate the captured resource before applying to a reused tab.

Workbench commits tab collections, active identity and open state in one Solid batch after resource creation or accepted closure. Restoration observes only the completed transition, so removal cannot allocate an intermediate resource or native page. Close guards retain the captured Session and resource identity while awaiting domain protection and reject duplicate in-flight closes.

One Browser catalog and WebSocket per Runtime and Scope are reused across Sessions; Session catalogs are retained for historical/local-file pages. Catalog reads allocate no native page and background activity cannot change human selection. On a Session switch, the same catalog reconciles that Session’s stored tabs, including closures that arrived while it was inactive. Notes retain editor state across tab/view unmounts and keep dirty, mounted or undoable controllers during clean-cache eviction. Draft backup failure remains visible and protects unload until saved or durably backed up.

## File change settlement

Turn file cards consume `UserMessage.summary.diffs`, `diffState` and `diffIssues` through the existing message update/reconcile path. Pending and partial settlements preserve already rendered rows and the user's expansion choice. Session Review consumes the session Diff projection; entry from a turn selects that root's summary and labels its scope. Workspace identity and generation remain part of file keys. On-demand historical file reads are cancelled when their expanded renderer is released. Restore previews bind to the selected connection, Scope and session; stale responses cannot authorize a new context.

First-input receipt recovery distinguishes durable acceptance, temporary unavailability and a definitive missing receipt. Unavailability retains observation; absence stops polling and presents explicit recovery with the captured draft. Manual retry uses the same message identity and payload, while accepted recovery clears only an unchanged submitting draft. Navigation timing begins at user intent and includes Scope lookup through data/composer readiness at paint. See [session interaction recovery](../decisions/implemented/bug-fix/2026-10-03-session-interaction-latency.md).

Virtual conversation segments keep lifecycle metadata separate from body ownership. A committed compaction card is emitted only by the body segment holding its recovery Part; process and footer segments do not synthesize another running card from an empty local Part set. Active and failed attempts without recovery have one footer lifecycle card. Terminal committed metadata establishes completion even while summary content is not hydrated; content presence controls expansion, not execution state.

### First-message submission handoff

At a new conversation's ordinary send, the composer allocates the future Session ID through the existing optional create input, a stable message ID and ordered Part IDs, then publishes its captured local submission in the existing preparation lease. Ordered plugin preflight still precedes durable Session creation, history and input admission. The lease also captures submission time, attachment order, original asset descriptors and server origin. Before canonical attachment admission, the shared temporary reader uses those descriptors. After validation, the composer clears only its captured draft revision. A read-only view exposes the lease to the formal message, attachment and process renderers without inserting a fictitious Session into the canonical store. Optimistic summary and body order both follow Part IDs. Lease handoff and navigation share one Solid transition because the router commits its target asynchronously; an ordinary synchronous batch could expose an empty draft owner before the Session route changes. Navigation transfers later draft edits into the new session while retaining the viewport, composer and display keys; accepted message aliases are scoped to connection, Scope and Session and bounded to 64 entries.

Matching canonical runtime activity outranks local receipt progress. Release the lease only after storage and connected Scope recovery have settled, canonical root admission, all captured Parts are present with matching summary/body versions, and matching runtime activity, assistant evidence or an authoritative turn execution snapshot is available. Existing optimistic bodies may remain the valid cached content after admission; requiring a different version prefix would strand a completed submission. The projection fills missing canonical summaries and bodies from the lease until then, so delayed execution or attachment reads cannot introduce an empty interval. Ongoing activity comes from the sequenced session status. Loading does not create a separate initialization card, and failures compose the shared ErrorCard with structured diagnostics and guarded recovery actions. Arrival motion is consumed at the first local display and never replayed at admission. Late restoration checks its captured revision and cannot overwrite later typing. Retrying a recovered draft preserves the next draft and restores it after the submitted draft clears.

Captured content marks its summary page complete only before canonical admission or while storage remains unready. An admitted root without a canonical page leaves that page unknown, allowing the existing summary loader and body materializer to restore caches cleared by the latest snapshot. Local content remains visible during that read, and its loading row reserves no additional height. Optimistic completeness must never suppress canonical content loading or strand local progress after execution finishes.

Managed output references in Part summaries let a final Markdown reference supersede its delivery gallery without hydrating older tool bodies. Output and prose references are bounded to 32 entries of 256 characters; prose extraction examines at most 256 KiB. Unknown remainder and unmanaged URLs retain their galleries. Evidence remains inside the process. The same per-Part suppression plan reaches hydrated segments, so collapsed history and replay preserve the placement.
