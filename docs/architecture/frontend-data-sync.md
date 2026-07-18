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

- pings every 20 seconds;
- waits 10 seconds for a pong;
- closes after three missed pongs;
- reconnects with jittered exponential delay from 1 to 30 seconds;
- ignores server heartbeat frames as transport liveness only.

Incoming events are batched on an approximately 16 ms cadence. Replaceable high-frequency state such as session status, inbox snapshots, LSP state, and full part updates is coalesced by identity before the Solid batch is applied.

## Store Shape

The sync layer has:

- one global store for paths, project list, providers, provider auth, and global Agenda data;
- one lazily created store per home/project Scope;
- message arrays keyed by session ID (window, not full transcript);
- `messageWindow` metadata keyed by session ID (cursor, hasMore, total, mode, pendingLatest);
- part arrays keyed by message ID;
- per-session buckets for status, diffs, todo, DAG, inbox, permissions, questions, and Plan Blueprint offers;
- per-Scope collections for sessions, agents, commands, config, MCP, LSP, VCS, Cortex, and Agenda.

**Diff data sources.** Two separate diff stores exist:

- **Turn-level diffs** are stored in `message[n].summary.diffs` on the user message and reach the frontend through the existing `message.updated` state event. No new event, store bucket, or route was needed — the normal message reconcile path carries them.
- **Session-level diffs** live in the `session_diff` bucket and aggregate all turn diffs for the Review workbench panel. They are loaded on demand through `sync.session.diff()` and never fetched implicitly.

Scope bootstrap limits concurrent instance requests to two. It first loads blocking provider, agent, config, and Scope identity state, marks the store `partial`, then loads remaining operational collections before marking it `complete`.

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
}
```

The `messages` array in the store contains only the visible window messages, not the full transcript.

### Page size and cap

- Default page size is 200; the store cap is 500.
- `Session.messagePage()` defaults `limit` to 200 and caps it at 500.
- The store's `DEFAULT_CAP` of 500 applies to both latest loads and history prepends.

### Latest mode

Initial load and reconnect recovery use latest mode (`mode: "latest"`). Incoming `message.updated` events reconcile into the window:

- If the message already exists, the window updates in place.
- If the message is new and the window is in latest mode, it is inserted and the window is capped by dropping the oldest messages.
- Dropped message IDs release their part buckets from the store.

The window cursor (`nextCursor`) is recorded from each page response so older pages can be loaded later.

### History mode

When the user requests older messages via "Load earlier", the frontend switches to history mode (`mode: "history"`):

- The existing window messages are preserved; older fetched messages are prepended.
- The combined set is capped at 500 by dropping the newest overflow (not the just-loaded older messages).
- A subsequent `message.updated` event for a message not already in the window sets `pendingLatest: true` instead of inserting it. The metadata retains the exact unseen IDs in `pendingLatestIds`, so duplicate updates do not add state and a matching `message.removed` clears only that notice without decrementing the window total for a message it never counted.
- `total` excludes those suppressed live arrivals while history mode remains active. Older-page responses are normalized by `pendingLatestIds`; returning to latest replaces the metadata with the server total and clears the pending IDs.

### Return to latest

"Return to latest" refetches `messagePage()` without a cursor, resetting `mode` to `"latest"` and clearing `pendingLatest`. The UI force-scrolls to the bottom. Stale-cursor errors during `loadMore` also automatically trigger this recovery: the frontend catches `SessionMessagePageCursorStaleError` and refetches latest.

### Scroll anchor

Successful prepend in history mode captures the DOM offset of the first visible message before the fetch and restores it afterward, keeping the visible conversation stable. `turnStart` is reset to 0 only after a successful load so failed loads do not disturb the turn pagination state.

## Initial and Explicit Loads

The generated SDK owns internal HTTP calls. Scope-specific clients carry home `scopeID` or project directory context.

Session detail loading is split by concern:

- session metadata loads independently;
- messages load through `session.messagePage()` in page size 200, stored in a bounded window capped at 500;
- parts are sorted and reconciled under their owning message;
- inbox, todo, DAG, diff, permissions, and questions have separate refresh paths.

Volatile state can be force-refetched after a reconnect or when an idle event indicates that a cached collection may have changed.

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

For `ok`, the frontend applies replayed events through the same event reducer and advances the Scope watermark. For `reset` or request failure, it refetches Scope snapshots: sessions, status, Cortex, Agenda, permissions, questions, retained inbox/todo/DAG buckets, and project MCP/LSP state.

When replay returns `reset`, the frontend also calls `resourceFreshness.resetScope()` before refetching. This advances the Scope generation, invalidates in-flight resource requests, and clears stale per-resource versions so the resync snapshots can establish fresh baselines.

Resources outside the normalized store, including BlueprintLoop feature state, observe `reconnectVersion` and refetch after connection recovery.

Active session message/part snapshots also observe reconnect recovery. Because tool-part updates are published as unsequenced streaming events, reconnect replay alone cannot restore a missed tool card. After a reconnect, `sync.session.sync()` force-reloads the viewed session's durable message/part snapshot in addition to volatile collections.

### Current recovery limitation

Reconnect replay starts from the watermark retained before the disconnect and is the reliable missed-event recovery path for sequenced state events.

The live gap detector currently adopts the newly received sequence before it starts `replayOrResync()`. A replay triggered only by that gap therefore starts at the new watermark rather than the pre-gap value. Maintainers must not describe live gap detection as proven backfill until the reducer retains the prior watermark for that request.

## Resource-Level Snapshot Freshness

The sync layer applies a freshness gate to DAG, Todo, and Inbox snapshots and live events. Each resource is scoped to `(scopeKey, sessionID, resource)`.

### Response headers

Scoped GET responses for these resources expose:

- `x-synergy-seq`
- `x-synergy-epoch`

The server captures the epoch and sequence number before reading the snapshot, so the value is a conservative lower bound for that response. The Web client reads both headers via `readSyncVersion()` and uses them in the freshness checks below.

A response is unversioned when either header is absent or the epoch/sequence values are invalid.

### Request tokens

Every snapshot request captures a `SyncResourceRequest` token:

- `generation` — a Scope-level monotonic counter. A new Scope epoch or `releaseScope` advances the generation, invalidating all in-flight requests for that Scope.
- `revision` — a per-resource counter that increments on every accepted event or snapshot for that resource. A revision mismatch means the resource was written between request capture and response arrival.

### Response acceptance

`acceptResponse()` checks the captured request before delegating every accepted response to `acceptSnapshot()`:

1. **Generation match.** If the current Scope generation differs from the request generation, the response is rejected — a Scope epoch switch or release occurred between request and response.

2. **Revision check.** If the resource revision changed while the request was in flight, an unversioned response is rejected. A versioned response may continue only when the resource has a known current version to compare against.

3. **Snapshot version guard.** Responses that pass the request-token checks still go through the epoch and sequence checks below.

### Snapshot version guard

`acceptSnapshot()` enforces:

- **Retired epochs are rejected.** An epoch that has been superseded cannot overwrite current state.
- **Snapshots cannot switch an established Scope epoch.** `prepareSnapshotScope()` rejects a snapshot whose epoch differs from the current Scope epoch when one exists. Events are authoritative for epoch transitions; a snapshot may establish only the initial epoch when no Scope version has been set.
- **Older snapshots are rejected.** A snapshot with `seq < current.seq` for the same resource and epoch is stale and discarded. Equal `seq` is accepted because the server stamps the sequence before reading.
- **Unversioned responses fail open conditionally.** An unversioned response is accepted when no intervening same-resource write occurred (revision unchanged). When an event updated the resource in flight, the response is rejected because it cannot prove it is newer. An accepted unversioned snapshot clears the stored resource version, so later ordering starts from the next valid version.

### Scope-level event pre-filter

Before any event reaches `applyEvent()`, the global listener calls `acceptScopeEvent(scopeKey, version)`. This applies to every incoming event, not only DAG, Todo, and Inbox updates:

- events from retired epochs are dropped without changing the watermark or triggering replay;
- an event from a new epoch retires the old epoch, advances the Scope generation, invalidates in-flight resource requests, clears per-resource versions, and establishes the new epoch floor;
- unversioned events, including streaming deltas, pass through without changing Scope freshness state.

This pre-filter runs before watermark observation and before the resource-specific `acceptEvent()` checks.

### Event acceptance

Live events (`todo.updated`, `dag.updated`, `session.inbox.updated`) pass through `acceptEvent()`:

- **Epoch advance.** An event with a new epoch retires the old epoch, advances the Scope generation (invalidating in-flight snapshot requests), clears all resource versions for that Scope, and establishes the new epoch.
- **Ordered only.** Within the same epoch, an event with `seq <= current.seq` for that resource is a duplicate and discarded.
- **Unversioned events** clear the resource version rather than preserving a comparison that can no longer be proven. A later unversioned snapshot may still fail open when its request was captured after that event and no same-resource write occurred in flight.
- Every accepted event bumps the resource revision.

### Resource scope

Per-resource snapshot/event ordering applies only to `dag`, `todo`, and `inbox`. All incoming events still pass through the Scope-level epoch pre-filter. Snapshots for other resources remain governed by the existing replay/resync behavior and are not subject to resource freshness checks.

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

The display projection preserves trim and project-path relativization across chunk boundaries. A part identity change, source shrink, or transition to terminal state rebuilds from the authoritative snapshot once. Terminal state comes only from the part's explicit end marker or the owning message's completion marker; coarse session status and the presence of a later timeline part do not terminate a renderer that can still receive deltas. The terminal Markdown path then performs the complete Marked, syntax, math, and sanitization render once and replaces the streaming tree. Its optional visual transition is one-shot and interrupt-safe: cancellation collapses the staged terminal tree immediately, and activation does not force a synchronous layout read.

Streaming Markdown creates a fixed set of token elements through DOM APIs and rejects unsafe link and image URL protocols before setting attributes. Raw model HTML is never assigned to `innerHTML` during streaming. Automatic bottom-following is coalesced so content growth schedules at most one scroll operation per animation frame.

## Server Part Write-Behind

Network streaming and disk persistence are separate optimizations.

`PartWriteBuffer` coalesces streaming text/reasoning persistence per part at a default 500 ms interval. It always retains the newest full part value.

- streaming increments defer disk writes;
- discrete tool/status changes write immediately;
- terminal writes cancel or supersede buffered values;
- loop finalization flushes every pending value;
- buffer cancellation is used only when an immediate authoritative write will replace it.

This removes quadratic full-part disk writes without weakening terminal persistence.

## Compaction Swap

`session.compacted` means the visible effective message set changed at a summary boundary.

The compaction event is first gated through `acceptEvent()` using the session's `inbox` resource key. A duplicate, older, or retired-epoch compaction event is discarded before any message swap or cleanup runs.

The frontend:

1. fetches the post-compaction messages via `session.messagePage()` while keeping the current timeline visible;
2. computes the messages to retain and the old part buckets to drop using `planMessagePageApply()`;
3. applies one Solid batch that deletes stale parts and diff state, and deletes inbox state only if no newer inbox event arrived while the fetch was in flight;
4. reconciles the retained messages, their authoritative parts, and the message window metadata atomically.

Fetch-before-swap prevents an empty timeline flash. Part buckets belonging to messages outside the new effective set must be released. The message window metadata (`nextCursor`, `hasMore`, `total`, `mode`, `pendingLatest`) is replaced atomically in the same batch, while newer Inbox state is preserved.

## Message Bucket Eviction

Loaded message and part buckets are memory-bounded independently of session metadata.

- the global LRU spans Scope/session bucket keys;
- at most 15 session buckets are retained;
- the actively viewed session is protected even if it is the oldest;
- eviction removes that session's message array, all parts owned by those messages, and the session's `messageWindow` metadata;
- revisiting an evicted session reloads it through normal message page sync.

Session lists, status, inbox, todo, and other non-message state are not evicted by this policy.

## Composer Intent

Composer model selection has strict one-way layering:

1. user draft selection
2. session default: explicit server `modelOverride`, otherwise last root message model
3. global/application fallback

Lower layers never write into higher layers. Selecting a model explicitly persists `modelOverride`; merely resolving a fallback does not mutate the session default or current draft.

Agent and workflow selections follow the same principle: server session fields are durable defaults, while unsent composer intent remains local until the user performs an action that explicitly persists it.

Variant display resolves the explicit or historical session variant first, then the agent default and configured model-role default. Only the session variant is submitted; displaying a configured fallback never writes it into message history.

## Invariants

- One global event WebSocket multiplexes events by owning Scope directory.
- State events are sequenced per Scope epoch; streaming events are unsequenced.
- Replay returns `ok` or `reset` JSON and full resync is the fail-open recovery.
- Bounded domain event queues use explicit recovery signals rather than silent loss. For File workspace watcher overflow, `file.watcher.updated` carries `resync: true`, and the File context reloads its root, expanded directories, and active document.
- Every event passes the Scope epoch pre-filter; DAG, Todo, and Inbox additionally use resource-level snapshot/event freshness (generation + revision tokens and version comparison). Unversioned snapshots are accepted only when no intervening same-resource write occurred.
- Store updates reconcile existing leaves and identities.
- Streaming deltas converge through full checkpoints.
- Active text rendering processes appended suffixes rather than rescanning accumulated snapshots.
- Disk write-behind never delays discrete or terminal persistence.
- Compaction fetches before swapping the visible message set.
- The active session survives message-bucket eviction.
- Composer fallback resolution never writes upward into user intent.
- The frontend message window is a viewport, not the full transcript. `messages()` and `messagePage()` serve different consumers.
- Latest mode keeps the newest messages and evicts oldest; history mode preserves the existing window and caps newest overflow.
- `messageWindow` metadata and messages are evicted together by the message-bucket LRU.
