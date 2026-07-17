# Sessions and Messages

## Session Contract

A session is the durable unit of work in Synergy. It belongs to one Scope, binds an execution workspace, stores its message history and operational state, and can be resumed by any client connected to the same runtime.

Session state includes, when applicable:

- Scope, workspace, title, category, timestamps, and archive state
- model and agent overrides
- control profile, permission rules, and pre-authorized actions
- endpoint identity for Channel or other external entrypoints
- parent or fork lineage
- Agenda, Cortex, BlueprintLoop, SuperPlan, or workflow metadata
- inbox, todo, DAG, history, completion, and recovery state

Session metadata is not the message transcript. Each has its own storage and events.

## Session Lineage

Synergy records two different relationships:

| Field        | Meaning                                                           |
| ------------ | ----------------------------------------------------------------- |
| `parentID`   | Runtime child ownership, primarily delegated/background sessions. |
| `forkedFrom` | A user-visible history fork copied from another session.          |

A fork is not a child task. It copies the source session's effective history and records `forkedFrom`; it does not use `parentID` to imitate delegation.

Child sessions inherit the parent workspace and interaction context by default. Their effective control profile is resolved through the parent chain rather than copied as an independent root profile.

## One Active Loop

`SessionManager.acquire()` synchronously grants one caller a generation-tagged loop lease before asynchronous session or workspace setup begins. The runtime keeps that lease as its owner through `starting`, `running`, and `stopping`; `signalAbort()` signals the owner controller and sets the phase to `stopping` but does not publish idle events or repair persisted state. Only `release()` with the exact current lease clears ownership and publishes the lifecycle idle event (`SessionEvent.Idle`), so stale cleanup cannot terminate a replacement loop. A second caller waits on the existing runtime instead of creating a competing writer.

This single-writer rule supports:

- ordered task execution
- deterministic message and part persistence
- a loop-scoped in-memory message cache
- safe abort and terminal repair
- one status stream per session

The durable session can outlive its in-memory runtime. Runtime state is reconstructed from persisted messages, `pendingReply`, workflow records, BlueprintLoop state, and recovery metadata after restart.

## Task Roots

A session processes a serial sequence of tasks. One root user message `R` owns each task.

- `R.isRoot = true`
- `R.rootID = R.id`
- non-root user injections for that task keep `rootID = R.id`
- every assistant message produced for the task has `rootID = R.id`
- newly written assistant messages also use `parentID = R.id`

The loop does not change ownership when a user steers it, a Cortex task reports back, compaction continues, or a workflow injects control context.

`SessionProgress.needsModelCall(messages, R.id)` asks whether the latest user message belonging to `R` has a later terminal assistant reply belonging to the same root. Terminal assistant finishes exclude `tool-calls` and `unknown`, which keep the model/tool loop active.

## Canonical Message Semantics

Message scheduling, presentation, model context, and provenance are orthogonal.

| Field              | Responsibility                                                      |
| ------------------ | ------------------------------------------------------------------- |
| `rootID`           | Which root task owns this message.                                  |
| `isRoot`           | Whether a user message starts an independent reply cycle.           |
| `visible`          | Whether a user message is rendered in the normal frontend timeline. |
| `includeInContext` | Whether the message is projected into model history.                |
| `origin`           | Who or what produced a user message.                                |
| part `origin`      | Whether text was authored by the user or injected by the system.    |

No consumer should infer one axis from another. For example:

- a non-root steer can be visible and included in context;
- a system-origin control message can be hidden but included in context;
- an action command can be visible in product history but excluded from model context;
- part origin identifies authorship and does not by itself control model visibility.

### Message origin

The closed top-level origin set is:

| Type         | Source                                               |
| ------------ | ---------------------------------------------------- |
| `user`       | Direct user input from a first-party client or API.  |
| `cortex`     | Delegated task or subagent delivery.                 |
| `agenda`     | Scheduled or triggered work.                         |
| `blueprint`  | BlueprintLoop control and review delivery.           |
| `channel`    | External messaging provider.                         |
| `compaction` | Compaction continuation.                             |
| `agent`      | Cross-session agent delivery such as `session_send`. |
| `plugin`     | Plugin delivery.                                     |
| `system`     | Other internal control or safe fallback.             |

Second-level meaning belongs in `origin.detail`, not in new top-level origin strings. Unknown legacy values decode to `system`.

Non-root origins that receive dedicated frontend chips are Cortex, Agenda, Blueprint, Channel, Agent, and Plugin. Rendering remains governed by `visible` plus the registered special renderers.

### Part origin

Text parts use `origin: "user" | "system"`. `MessageV2.isSystemPart()` is the canonical predicate. It also understands legacy `synthetic` parts at the read boundary.

Part origin answers who authored the text. It does not remove the part from model context. Message `includeInContext` and attachment model policy own context inclusion.

## Read-Time Canonicalization

Persisted histories may contain older metadata shapes. `MessageV2.deriveSemantics()` is the only read-time derivation for canonical message fields.

It runs over the complete ordered raw message list before pagination or slicing so root ownership can be derived consistently. It:

- maps legacy source metadata into canonical `origin`;
- derives `isRoot`, `rootID`, `visible`, and `includeInContext` when absent;
- maps legacy synthetic text into part origin;
- gives assistants the active root when an older record lacks `rootID`.

Downstream loop, compaction, history, and frontend code read canonical fields. They must not recreate the retired metadata heuristics.

When a paginated result contains a non-root message whose root lies outside the page, session history loading adds the missing root record so consumers do not lose task identity.

Transcript consumers use the ordered message array as the chronology. Current message IDs are monotonic, but persisted sessions may contain legacy stable delivery IDs whose lexical order is unrelated to creation time. The read boundary restores those records by `time.created`; loop, rollback, fork, and other positional logic must not compare raw message IDs to decide whether one message is before or after another.

## Message Page API

`Session.messagePage()` and `GET /session/:sessionID/message/page` (`operationId: session.messagePage`) provide additive cursor-based pagination over effective session history. The existing `Session.messages()` and `GET /session/:sessionID/message` remain unchanged and are the correct path for runtime loops, export, preview, and flat consumers that need the complete message array or a simple tail slice.

### Query parameters

| Parameter | Type     | Meaning                                                                                  |
| --------- | -------- | ---------------------------------------------------------------------------------------- |
| `cursor`  | `string` | Opaque cursor returned by the previous page. Omit it to request the latest message page. |
| `limit`   | `number` | Page size from 1 to 500. Defaults to 200.                                                |

### Cursor format

Cursors are opaque base64url-encoded JSON with a v1 schema:

```ts
{ v: 1, a: "<message-ID>", d: "before" }
```

The anchor `a` is a message-ID equality boundary; the direction `d` is always `"before"`. A request without a cursor returns the latest (newest) page. A request with a cursor returns strictly older messages ending at the anchor; the anchor message itself is excluded.

### Response

| Field             | Type                    | Meaning                                                                              |
| ----------------- | ----------------------- | ------------------------------------------------------------------------------------ |
| `items`           | `MessageV2.WithParts[]` | Page of messages in canonical chronological order, oldest first.                     |
| `referencedRoots` | `MessageV2.WithParts[]` | Root messages whose IDs appear as `rootID` in items but are not themselves in items. |
| `nextCursor`      | `string \| null`        | Encoded cursor for the next older page, or `null` when no older messages remain.     |
| `hasMore`         | `boolean`               | `true` when older messages exist beyond this page.                                   |
| `total`           | `number`                | Total effective message count.                                                       |

`referencedRoots` provide task identity for non-root items whose root lies outside the page. They do not determine `nextCursor` or `hasMore`.

### Cursor lifecycle

- An invalid cursor (bad encoding or unknown schema version) returns a 400 `SessionMessagePageCursorInvalidError`.
- A stale cursor (anchor message no longer in effective history after rollback or compaction) returns a 400 `SessionMessagePageCursorStaleError`. The frontend recovers by refetching the latest page.

### Relationship to messages()

| Property              | `messages()`                   | `messagePage()`                  |
| --------------------- | ------------------------------ | -------------------------------- |
| Result                | Full history or tail slice     | Fixed-size page with cursor      |
| Consumer              | Runtime, export, preview, flat | Bounded frontend window          |
| Referenced roots      | Included inline                | Separate `referencedRoots` array |
| Cursor pagination     | No                             | Yes — opaque base64url v1 cursor |
| Stale-cursor recovery | N/A                            | Refetch latest                   |

## Message Parts

Messages contain ordered parts rather than separate tool and text timelines. Current part kinds include:

- text and reasoning
- attachments with explicit model and presentation policies
- tool calls with pending, generating, running, completed, or error state
- step start and finish boundaries
- snapshots and file patches
- retry records
- compaction requests and compaction recovery records

The original part order is the transcript order. Frontends must not regroup text, reasoning, tools, and attachments into a second synthetic step model.

Tool output and metadata are bounded before persistence. Streaming text and reasoning writes use write-behind, while discrete and terminal writes remain immediate; see [Frontend data sync](frontend-data-sync.md).

### Assets and attachments

Attachments are durable parts with separate model and presentation policies. Model policy can provide a summary, extracted content, a provider-managed file, or no model input. Presentation policy can select image/video/audio/thumbnail/file rendering, size, crop, or hidden state.

Inline data and returned tool attachments are externalized to the Asset store as `asset://` references when appropriate. Provider file IDs remain provider inputs; local paths remain explicit workspace references. Repeated historical images are deduplicated and bounded during model projection without removing their transcript parts. Asset routes validate IDs inside the Asset root rather than accepting arbitrary filesystem paths.

## Turn Diffs

Each user message may carry computed file-change diffs from the turn's snapshot/patch parts. Diffs are stored in `summary.diffs` on the `UserMessage` schema and surfaced to the frontend through the existing `message.updated` reconcile flow — no separate event, store, or route.

### Diff state machine

`summary.diffState` records the lifecycle of diff computation for a turn:

| Status    | Meaning                                                                                                                   |
| --------- | ------------------------------------------------------------------------------------------------------------------------- |
| `pending` | Diff is being computed; includes the server-owned expiry marker `deadlineAt` (epoch ms) for timeout and restart recovery. |
| `ready`   | Diffs computed successfully.                                                                                              |
| `error`   | Diff computation failed; carries a safe error `code` (`timeout`, `git_failure`, or `unknown`).                            |

The non-blocking summary `LoopJob` derives turn diffs in this order:

1. fresh-merge `diffState: { status: "pending", deadlineAt }` on the user message before `computeDiff()` so the frontend sees the pending state immediately;
2. call `computeDiff()` using the snapshot range from every assistant revision belonging to the root turn;
3. on success, write `{ diffs, diffState: { status: "ready" } }` atomically;
4. on failure, write `{ diffState: { status: "error", code } }`; on a per-run timeout, apply `error/timeout` only if the diff is still `pending`, preserving an already-`ready` settlement while later enrichment or session aggregation finishes.

Title generation may continue after either outcome. Body generation runs only when diff settlement succeeded with a non-empty diff set. Diff errors persist safe error codes only and do not block the session or later queued turns. A stale persisted `pending` state is projected to `error/timeout` at the backend read boundary after its deadline; the frontend renders the server settlement state and never compares `deadlineAt` with the client clock.

### Ordering and caching

Summary computation is FIFO per session. Queue identity includes the terminal assistant revision, so later continuations of the same root turn are processed while duplicate triggers for one revision are coalesced. Each worker must settle after cancellation before the queue advances, preventing timed-out work from overwriting a later revision. Each `summarizeNow()` run owns a `diffCache` that lets its session-level and turn-level computations reuse the same in-flight snapshot-range promise when their bounds match.

### Schema

`diffState` is an optional additive field on `summary`:

```ts
diffState?: {
  status: "pending"
  deadlineAt: number
} | {
  status: "ready"
} | {
  status: "error"
  code: "timeout" | "git_failure" | "unknown"
}
```

`summary.diffs` is always present when `summary` exists (default empty array).

### Invariants

- A ready settlement writes `diffState` and `summary.diffs` in the same `updateSummary` call; an error settlement writes only its safe state and preserves existing summary fields.
- A message without `diffState` but with non-empty `diffs` is treated as legacy `ready` at the read boundary.
- `deadlineAt` is a server recovery marker. Clients render the persisted settlement state and do not derive terminal state from their local clock.
- `summary.diffs` is the sole turn-level diff data source. The session-level `session_diff` bucket is a separate aggregation of all turn diffs for the Review workbench panel.
- No migration, route, event, storage export version, config, or new runtime module was required for the diff settlement flow; it uses only the existing summary infrastructure.

## Persistent Inbox

All delivery into an existing session uses the persistent `SessionInbox`. There is no separate in-memory mailbox.

Every item has one scheduling axis:

| Mode      | Root          | While loop is active                                    | While session is idle                         |
| --------- | ------------- | ------------------------------------------------------- | --------------------------------------------- |
| `task`    | New root      | Waits until the current task ends.                      | Starts a new loop.                            |
| `steer`   | Existing root | Materialized before the next `needsModelCall` decision. | Wakes the latest root if one exists.          |
| `context` | Existing root | Piggybacks only after a model call is already required. | Remains stored and does not wake the session. |

Stable delivery keys deduplicate inbox items independently from transcript message IDs. Materialization persists the assigned message ID, and task, steer, and context order remains stable through `orderKey`; legacy hash-based transcript IDs are supported only at the read boundary.

Typical mappings:

- a new user prompt, Agenda run, Channel request, or Blueprint start uses `task`;
- an active-user interruption, Cortex completion, review rejection, or workflow continuation uses `steer`;
- passive information intended for the next natural model call uses `context`;
- assistant-role cross-session delivery materializes immediately against the latest root.

Promoting a queued user task to guide/steer changes the inbox mode instead of writing permanent guided/no-reply metadata into the message model.

On abort, steer and context items are discarded while queued task items remain for explicit later execution.

If a loop run fails while runnable inbox work remains, release still yields ownership but does not immediately request another drive cycle. The durable inbox item remains available for an explicit retry or a later delivery-triggered wake instead of entering a tight self-wake loop.

## Model Context Projection

`MessageV2.toModelMessage()` projects canonical session history into provider messages.

- messages with `includeInContext = false` are skipped;
- compacted history is filtered at the compaction boundary;
- attachment model policy decides whether an attachment contributes content, summary, provider file data, or nothing;
- only a bounded number of historical images are retained;
- tool calls and results are emitted in provider-compatible order;
- duplicate terminal tool parts from older histories are collapsed by provider call ID, preferring the execution outcome over an AI SDK fallback diagnostic;
- workflow wrappers are applied ephemerally and do not rewrite stored user text.

Visible history and model context can therefore differ intentionally without losing the durable record.

## Rollback, Redo, and File Restore

History rollback is an event overlay on the raw transcript.

- A rollback records the cut, dropped message IDs, affected root turns, and available patch parts.
- Effective history applies rollback and unrollback events without deleting raw messages.
- Redo is allowed only for the latest active rollback and only before new messages make it ambiguous.
- Model context, summaries, session forks, and frontend history use effective history.

Rollback does not modify project files. File restoration is a separate explicit operation that applies stored snapshot patch data for selected files or parts.

## Archive and Deletion

Archiving is the normal user-facing removal state. Archived sessions remain persisted and can be managed through session APIs and CLI operations. Permanent deletion removes session-owned records and indexes according to the storage contract.

Code that displays session lists must respect archive state and the Scope-local page index rather than scanning message directories as its primary listing path.

## Recovery

The runtime repairs interrupted state instead of assuming every process exit occurred at a clean turn boundary.

Recovery covers:

- persisted `pendingReply`
- incomplete assistant messages
- interrupted Cortex delegations
- active BlueprintLoops and their execution/audit bindings
- Light Loop and Lattice workflow sessions
- stale note `activeLoopID` and session loop metadata

An interrupted assistant that never reached terminal persistence is completed with an explicit error during repair. Recovery state is surfaced as `recovering`; it is not presented as ordinary busy work.

### Abort status synchronization

When a running session is aborted, `signalAbort()` signals the owning controller and sets the phase to `stopping` but does not publish events or repair durable state. The abort HTTP route additionally calls `repairAfterAbort()` to repair the persisted incomplete assistant message and synchronize the frontend status.

`repairAfterAbort()` reads `SessionWorking.resolve()` (the same canonical check used at startup) to decide whether the repaired session is truly idle or still has active work (workflows, BlueprintLoops, incomplete assistants, or pending reply). It then publishes a status-only idle event through `SessionManager.publishStatusOnly()`, which emits `SessionEvent.Status` with `{ type: "idle" }` but never publishes `SessionEvent.Idle`.

This separation exists because `SessionEvent.Idle` has side-effect consumers — `ContinuationKernel` for automatic loop wakeups and session completion notifications — that must not fire for repair-only status corrections. Lifecycle idle (`SessionEvent.Idle`) remains owned exclusively by `SessionManager.release()`, which publishes both `SessionEvent.Status` and `SessionEvent.Idle` when the runtime loop voluntarily yields ownership.

## Invariants

- A session belongs to one Scope and has one current workspace.
- At most one active loop lease owns a session, including while it is starting or stopping.
- One root user message owns each task and all assistant messages in that task.
- `rootID`, `visible`, `includeInContext`, and `origin` remain orthogonal.
- `MessageV2.deriveSemantics()` and `MessageV2.isSystemPart()` are the canonical legacy boundaries.
- Transcript chronology comes from the canonical ordered message array; raw message ID comparison is not a temporal boundary.
- All incoming work uses the persistent inbox and one mode axis.
- Rollback changes effective history; file restore changes files only through an explicit action.
- Parent lineage and fork lineage remain distinct.
- Durable state must be sufficient to recover after the in-memory runtime disappears.
- Only `SessionManager.release()` publishes `SessionEvent.Idle`; repair paths publish `SessionEvent.Status` only.
- `Session.messages()` returns the complete effective array for runtime consumers; `Session.messagePage()` returns bounded cursor pages for the frontend window. Neither supersedes the other.
- Cursors are opaque base64url v1 anchors. Consumers must not decode or derive meaning from cursor internals.
