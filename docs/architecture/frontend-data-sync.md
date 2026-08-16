# Frontend Data Sync

## Purpose

The Web application maintains reactive projections of server-owned state. Initial and explicit loads come from generated SDK requests; ongoing changes arrive through one global event connection and are routed into global or Scope-local stores.

The sync layer optimizes identity stability, reconnect recovery, streaming cost, and bounded memory. It is not a complete normalized entity database: some feature resources remain component-owned and must refetch after reconnect.

## Connection Model

`GlobalSDKProvider` opens one WebSocket to:

```text
/global/event/ws?stream=delta
```

The server sends envelopes containing:

```ts
{
  directory: string
  payload: Event
}
```

`directory` routes the event to the home, project, or global emitter. A session executing in a worktree still emits to the directory of its owning Scope, not to a second store for the worktree path.

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

Incoming events are batched on an approximately 16 ms cadence while visible. Replaceable high-frequency state such as session status, inbox snapshots, LSP state, and full part updates is coalesced by identity before the Solid batch is applied. While the page is hidden the cadence relaxes to 1 second and streaming `message.part.delta` frames are merged per part into a single pending delta (the ≤1 s server checkpoint converges the authoritative part), keeping the background main-thread cost bounded without dropping sequenced state events. The event queue is capped; when the cap is reached it flushes early so watermarks keep advancing.

## Store Shape

The sync layer has:

- one global store for paths, project list, providers, provider auth, and global Agenda data;
- one lazily created store per home/project Scope;
- message arrays keyed by session ID (window, not full transcript);
- `messageWindow` metadata keyed by session ID (cursor, hasMore, total, mode, pendingLatest, tailMissingLatest);
- `latestContextMessage` keyed by session ID, holding the latest eligible assistant snapshot independently of the visible message window;
- part arrays keyed by message ID;
- per-session buckets for status, diffs, todo, DAG, inbox, permissions, questions, and Plan Blueprint offers;
- per-Scope collections for sessions, agents, commands, config, MCP, LSP, VCS, Cortex, and Agenda.

**Diff data sources.** Two separate diff stores exist:

- **Turn-level diffs** are stored in `message[n].summary.diffs` on the user message and reach the frontend through the existing `message.updated` state event. No new event, store bucket, or route was needed — the normal message reconcile path carries them.
- **Session-level diffs** live in the `session_diff` bucket and aggregate all turn diffs for the Review workbench panel. They are loaded on demand through `sync.session.diff()` and never fetched implicitly.

Global bootstrap starts the health check and the global config/path/Scope/provider/auth requests concurrently. Scope bootstrap limits concurrent instance requests to two. Each instance uses the generated `scope.bootstrap()` snapshot to load required provider, agent, config, and Scope identity plus optional path, command, session status/list, MCP, Cortex, Agenda, and project LSP/VCS state. The snapshot is reconciled in one Solid batch before the store becomes `partial`; permissions and questions keep their independent owner routes, and the store becomes `complete` after those requests settle.

## Reconcile, Do Not Replace

Existing store objects and list entries are updated with Solid's `reconcile()`.

This is an invariant for event handlers and refetches:

- use a stable entity key such as `id` or `file` for collections;
- reconcile an existing session, message, part, permission, question, Agenda item, or other entity;
- use `produce()` only for insertion, removal, a narrow leaf mutation, or coordinated bucket deletion;
- do not replace a whole object merely because one event carries a complete serialized value.

Preserving unchanged identities keeps memos and components that read unrelated leaves from invalidating on every timestamp, status, or streaming update.

Streaming delta application is even narrower: it appends only to the `text` leaf of the matching text/reasoning part.

## Message Window and Cursor Pagination

The frontend maintains a per-session bounded message window backed by cursor-based pagination via `GET /session/:sessionID/message/page` (generated SDK `session.messagePage`). The unbounded `messages()` API and `/session/:sessionID/message` route remain available for runtime loops, export, and preview consumers.

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

- Frontend page loads use `limit: 200`; the store primary-message cap is 500.
- The store's `DEFAULT_CAP` of 500 applies to primary messages in latest loads and to the full retained set during history prepends. Latest mode additionally retains dependency roots referenced by those primary messages, so the visible window may exceed 500 entries without losing a turn anchor.

### Latest mode

Initial load and reconnect recovery use latest mode (`mode: "latest"`). Incoming `message.updated` events only reconcile into the visible window when both `messages[sessionID]` and `messageWindow[sessionID]` are present — the session message bucket must be loaded. When either is absent (session never loaded or bucket evicted), the event advances resource freshness and the `latestContextMessage` projection but does not create a message window from empty state. The window is instead established by `messagePage` when the user enters the session.

- If the session message bucket is loaded and the message already exists, the window updates in place.
- If the message is new and the window is in latest mode, it is inserted and the primary window is capped by dropping the oldest unreferenced messages.
- Any root referenced through `rootID` by a retained primary message stays in the window outside the cap. Snapshot `referencedRoots` and live event reconciliation preserve the same dependency-root closure so non-root user guidance always retains its `SessionTurn` anchor.
- Dropped message IDs release their part buckets from the store.

The window cursor (`nextCursor`) is recorded from each page response so older pages can be loaded later.

### Latest Context projection

Context status and workbench consumers read `sync.session.latestContextMessage(sessionID)` rather than deriving latest usage from the bounded `messages` viewport. The projection is owned by sync and has three states: a missing key (`undefined`) is uninitialized and permits a temporary fallback to an already-loaded eligible viewport message, `null` means an authoritative latest page contained no eligible assistant and forbids that fallback, and a message is the latest ordered context-usage record.

Eligible usage snapshots are assistant messages with `includeInContext !== false` and either structured `contextUsage` or a non-zero legacy input, output, or reasoning token total. A completed included compaction assistant is instead an ordered invalidation barrier: it sorts after pre-compaction usage but does not expose the compaction call's own tokens as conversation context usage. Consumers show usage as unknown until the next ordinary assistant snapshot. Canonical chronology is `time.created`, then `id`; a later ineligible zero-usage assistant does not erase an earlier eligible snapshot.

Context Usage category enrichment is asynchronous and fail-open. The terminal assistant update can arrive first with provider token totals only; a later ordinary `message.updated` event atomically adds only the category snapshot when the isolated estimator succeeds. If estimation is unavailable, the totals-only assistant remains authoritative and the frontend does not wait or synthesize a breakdown.

Every no-cursor latest page apply seeds the projection, including normal session loads, navigation prefetch, reconnect/recovery refreshes, return-to-latest, stale-cursor recovery, and compaction reloads. Cursor/history pages never replace it. Latest page loads and background prefetches capture a `message` resource request token before the request. A latest response may replace the visible window only if no newer message event, authoritative part checkpoint/removal, history prepend, or optimistic local message write invalidated that token while it was in flight. Background prefetches additionally run only when no message window exists, so they populate an initially empty bucket rather than displace a loaded conversation.

Latest-page loading treats a freshness rejection as a superseded attempt, not a successful empty apply. The session message loader retries once with new request tokens and reports the bucket ready only after an apply succeeds. Repeated supersession becomes a visible load error while preserving any previously successful snapshot.

Each asynchronous latest-page request also captures a per-session projection revision. A newer latest-page request or a persisted `message.updated`/`message.removed` event advances that revision. After resource freshness accepts a page, the projection revision independently prevents an older response from overwriting newer event-driven Context usage. Complete persisted `message.updated` events reduce the projection inside the accepted event write even while history mode suppresses insertion into `messages`. Removing the projected message invalidates the key without a per-event request; the next authoritative latest page restores it.

### History mode

When the user requests older messages via "Load earlier", the frontend switches to history mode (`mode: "history"`):

- The existing window messages are preserved; older fetched messages are prepended.
- The combined set is capped at 500 by dropping the newest overflow (not the just-loaded older messages). If the cap cuts inside a logical root turn, the whole partial trailing turn is dropped so the kept tail is complete and stays at or under the cap.
- A subsequent `message.updated` event for a message not already in the window sets `pendingLatest: true` instead of inserting it. The metadata retains the exact unseen IDs in `pendingLatestIds`, so duplicate updates do not add state and a matching `message.removed` clears only that notice without decrementing the window total for a message it never counted. A prepend that cap-evicts messages filters any of their IDs out of `pendingLatestIds`: they are no longer unseen arrivals but are gone from the window, so the tail gap is tracked by `tailMissingLatest` instead.
- `total` excludes those suppressed live arrivals while history mode remains active. Older-page totals are reduced by the count of remaining `pendingLatestIds` so suppressed live arrivals do not inflate the displayed total; returning to latest replaces the metadata with the server total and clears the pending IDs.

History page responses are intentionally applied without snapshot-version ordering because they extend the existing window rather than replace it. Applying a history page invalidates the `message` resource revision so a concurrent latest-page response cannot subsequently overwrite the prepended window.

### Return to latest

"Return to latest" refetches `messagePage()` without a cursor, resetting `mode` to `"latest"` and clearing `pendingLatest`. The UI force-scrolls to the bottom. Stale-cursor errors during `loadMore` also automatically trigger this recovery: the frontend catches `SessionMessagePageCursorStaleError` and refetches latest. Heading from a scrolled-up history view back to the local bottom reuses the same recovery when the window has a tail gap (`tailMissingLatest`) or unseen arrivals are pending and no history load is in flight; gap-less history keeps the previous scroll behavior.

### Scroll anchor

Successful prepend in history mode captures the DOM offset of the first visible message before the fetch and restores it afterward, keeping the visible conversation stable. The session page's `turnStart`, which controls how many user turns are visible in the scroller, is reset to 0 only after a successful load so failed loads do not disturb the turn pagination state.

While pinned at the bottom of a latest-mode conversation, the session page keeps the rendered turn tree bounded: when new turns push the visible count past `MAX_RENDERED_TURNS` (40), `turnStart` advances so the oldest turns are trimmed from the DOM. Trimming only happens when the user is at the bottom; history, scrolled-up, and user-scrolled states keep the full window (the "Load earlier" button restores trimmed turns). Because the scroller disables native `overflow-anchor`, the viewport is re-pinned to the bottom after the trim layout settles. A focused/hash-linked message that falls outside the trimmed window clears its active marker so scrollSpy falls back to the newest message.

## Initial and Explicit Loads

The generated SDK owns internal HTTP calls. Scope-specific clients carry home `scopeID` or project directory context.

Rollback feedback suppression reads the server-owned `session.rollbackAck` from the synchronized session record. When the rollback dialog is presented, the client immediately records a page-local pending key to prevent duplicate effects while `session.rollbackAck()` and the resulting `session.updated` event complete. The pending key is only a round-trip barrier: it is not persisted in browser storage, and a new rollback ID remains eligible even if an older key or acknowledgment exists.

Scope initialization uses `GET /scope/bootstrap` (`scope.bootstrap()`). The server reads the aggregated fields concurrently. Provider, agent, and config are required; failure in any of them fails the request. Optional field failures keep the response usable and are reported by field in `_errors`. Home snapshots omit project-only LSP and VCS fields.

Session detail loading is split by concern:

- session metadata loads independently;
- messages load through `session.messagePage()` in page size 200, stored in a bounded window capped at 500;
- parts are sorted and reconciled under their owning message;
- inbox, todo, and DAG refresh together through `session.volatileBatch()`, while diff, permissions, and questions retain separate refresh paths.

An accepted local root remains visible through a client-only optimistic marker when the queued response assigns a different canonical message ID. Acceptance atomically rekeys the message, its part bucket, and any history-mode pending ID instead of deleting the rendered root. Authoritative events and latest pages replace the marked message when the same ID materializes; until then, canonical-only actions and new-session transition completion remain blocked, while Inbox timeline cards still deduplicate by rendered message ID.

Ordinary new-session input uses the generated `session.input()` method. A queued response is a durable partial Inbox mutation rather than a complete Inbox snapshot: the client validates the response against the captured Inbox request token and response watermark, reconciles the returned item into the Scope store, then invalidates the resource version so the complete `session.inbox.updated` event at the same sequence remains eligible. This makes the accepted prompt visible even when the event connection is delayed or disconnected.

The new-session transition records the accepted item's message ID and remains blocking after the HTTP response. It changes to success only after the corresponding visible canonical root message is present in the message window; the three-second success hold begins at that handoff. If the pending Inbox item disappears before the root is observed, the active session forces one messages-and-volatile refresh to converge cross-resource event ordering. Inbox items whose message IDs are already materialized are omitted from the pending timeline.

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

Message-page requests also capture a local per-message part revision map. Applied delta, checkpoint, and removal events advance only the affected message revision. A mutation applied to an existing local bucket makes an otherwise accepted snapshot preserve that live bucket. A checkpoint or removal ignored because its parent message is outside the loaded window marks that message as requiring a newer snapshot; an in-flight page retries only when its returned effective window contains the affected message, so unrelated orphan events do not supersede the whole session page. Scope release and message-bucket eviction retire these local request tokens.

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

Streaming frames remain unsequenced because they are convergent rather than journaled state. If a delta arrives before its part exists locally, the frontend ignores it; the next full checkpoint creates or corrects the authoritative part.

Encoder checkpoint state is transport-local. The global WebSocket delta clients share one encoder because they receive the same frames; each SSE connection owns another encoder. A global encoder shared across independent transports would let one consumer's checkpoint timing corrupt another's convergence.

### Incremental presentation

The reconciled `part.text` string remains the authoritative frontend snapshot. Active text and reasoning renderers keep an offset into that snapshot and pass only the appended suffix through the display projection and the streaming Markdown parser. They do not compare, transform, or replay the accumulated prefix on each update, and they do not create a separate character-rate backlog between the event stream and the renderer.

The display projection preserves leading-trim behavior without rewriting model-authored Markdown, including absolute paths, across chunk boundaries. A part identity change, source shrink, or transition to terminal state rebuilds from the authoritative snapshot once. Terminal state comes only from the part's explicit end marker or the owning message's completion marker; coarse session status and the presence of a later timeline part do not terminate a renderer that can still receive deltas. The terminal Mark…

Streaming Markdown creates a fixed set of token elements through DOM APIs and rejects unsafe link and image URL protocols before setting attributes. Raw model HTML is never assigned to `innerHTML` during streaming. Automatic bottom-following is coalesced so content growth schedules at most one scroll operation per animation frame.

While the page is hidden, per-part delta frames are merged into one pending delta per part before application; a full `message.part.updated` checkpoint for the same part clears that pending delta (the checkpoint is authoritative, so merged deltas never double-append). Visible pages keep per-delta application so token receive telemetry stays intact.

## Server Part Write-Behind

Network streaming and disk persistence are separate optimizations.

`PartWriteBuffer` coalesces streaming text/reasoning persistence per part at a default 500 ms interval. It always retains the newest full part value.

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
- at most 15 session buckets are retained;
- the actively viewed session is protected even if it is the oldest;
- eviction removes that session's message array, all parts owned by those messages, the session's `messageWindow` metadata, and its latest Context projection;
- revisiting an evicted session reloads it through normal message page sync.

Session lists, status, inbox, todo, and other non-message state are not evicted by this policy.

## Composer Intent

Composer model selection has strict one-way layering:

1. user draft selection
2. session default: explicit server `modelOverride`, otherwise last root message model
3. global/application fallback

Lower layers never write into higher layers. Selecting a model explicitly persists `modelOverride`; merely resolving a fallback does not mutate the session default or current draft.

Agent and workflow selections follow the same principle: server session fields are durable defaults, while unsent composer intent remains local until the user performs an action that explicitly persists it.

Variant display resolves the explicit or historical session variant first, then the agent default and configured model-role default. Existing sessions keep this resolution unready while their model or message history is unavailable, so the composer neither exposes a configured fallback nor submits a normal model request until history can distinguish an inherited variant from no explicit variant. An explicit session draft, including an explicit clear, remains authoritative without waiting for history. Only the session variant is submitted; displaying a configured fallback never writes it into message history.

## Composer Interaction State

The active Web Composer owns one in-memory document controller. A snapshot contains a monotonic revision, editable text, UTF-16 selection offsets, optional Session identity, and normal/shell mode. File pills and other non-editable nodes remain in the controller's private DOM mapping and edits crossing them are rejected. Completion, decoration, and edit APIs share this revision boundary, so an asynchronous result cannot mutate a newer draft.

Composer snapshots, settled-draft notifications, selected-text snapshots, completion, and decorations are transient interaction state. They are not server snapshots, Scope store buckets, persisted records, global events, replay items, or reconnect-recovery inputs, and their text is not written to diagnostic logs. Scope/Session navigation and component or plugin-generation disposal cancel active callbacks instead of replaying them after remount.

## Invariants

- One global event WebSocket multiplexes events by owning Scope directory.
- State events are sequenced per Scope epoch; streaming events are unsequenced.
- Replay returns `ok` or `reset` JSON and full resync is the fail-open recovery. Live gaps replay from the retained pre-gap watermark and do not apply the triggering event before recovery.
- Scope bootstrap is one aggregated generated-SDK snapshot plus independent permission/question requests; reconnect invalidates volatile freshness for all retained sessions, clears inactive volatile buckets, and batch-refreshes only the viewed session.
- Bounded domain event queues use explicit recovery signals rather than silent loss. For File workspace watcher overflow, `file.watcher.updated` carries `resync: true`, and the File context reloads its root, expanded directories, and active document.
- Every event passes the Scope epoch pre-filter; DAG, Todo, Inbox, and Message additionally use resource-level snapshot/event freshness (generation + revision tokens and version comparison). Optimistic message writes and authoritative part mutations for messages present in the loaded window invalidate concurrent Message requests; streaming deltas do not. Unversioned snapshots are accepted only when no intervening same-resource write occurred.
- Store updates reconcile existing leaves and identities.
- Superseded latest-message snapshots retry before a bucket is marked ready; per-message part decisions apply unchanged buckets, preserve newer live buckets, and retry only pages that contain an ignored out-of-window mutation.
- Streaming deltas converge through periodic checkpoints and a final full checkpoint on normal completion, error, or abort.
- Active text rendering processes appended suffixes rather than rescanning accumulated snapshots.
- Session-scoped snapshot reads flush pending part write-behind first, and disk write-behind never delays discrete or terminal persistence.
- Compaction fetches before swapping the visible message set and uses the same supersession recovery as ordinary latest loads.
- The active session survives message-bucket eviction.
- Composer fallback resolution never writes upward into user intent.
- The frontend message window is a viewport, not the full transcript. `messages()` and `messagePage()` serve different consumers.
- Latest mode keeps the newest messages and evicts oldest; history mode preserves the existing window and caps newest overflow.
- `tailMissingLatest` marks a history window whose newest overflow was cap-evicted; history prepends, reconciles, and removals preserve it, latest page applies clear it, and bottom-return recovery re-fetches latest only in history mode when it is set or unseen arrivals are pending and no history load is in flight.
- Only a loaded session message bucket — both `messages[sessionID]` and `messageWindow[sessionID]` present — forms an authoritative visible window. Incoming `message.updated` events for an unloaded or evicted session advance resource freshness and the `latestContextMessage` projection but must not create a message window from empty state. The window is established by `messagePage` when the user enters the session.
- `messageWindow` metadata and messages are evicted together by the message-bucket LRU.
- Latest Context usage is sync-owned and independent of history viewport suppression; authoritative latest pages seed it and bucket eviction removes it.
- The event queue relaxes to a 1 s cadence and merges streaming deltas per part
  while the page is hidden; sequenced state events are never dropped, and a hidden page does not ping the server (the server's own heartbeat keeps the transport alive). Visible pages return to the 16 ms cadence and probe the connection immediately.
- Single-message reconcile inserts into the sorted window incrementally
  (binary-search insertion point) instead of re-merging and re-sorting the whole window; the window order and eviction semantics stay canonical.
- The rendered turn tree is bounded: while pinned at the bottom in latest mode,
  `turnStart` advances so at most `MAX_RENDERED_TURNS` user turns are mounted; the trim re-pins the scroller after layout settles.
- Each `SessionTurn` consumes a precomputed projection of its turn members
  instead of rescanning the message window, so a new message invalidates only the projection memo rather than every rendered turn.
- `BrowserViewEffects` keeps its handled-callID set bounded to the timeline
  window, releasing callIDs that were trimmed or switched away.
