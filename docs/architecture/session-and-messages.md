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

## Session Mutation and Index Projection

Runtime mutation of an existing session is serialized per Scope and session. The mutation writes canonical session info once through `Storage.update()`, then projects the resulting state into the session, page, child, navigation, and endpoint indexes before the next mutation for that session can begin. Activity updates, completion acknowledgements, last-exchange updates, and removal participate in the same boundary, so a projection cannot rewrite canonical metadata from an older snapshot.

Page and navigation indexes are shared by every session in a Scope, while a child index is shared by siblings under one parent. Their read-modify-write operations use separate domain locks so mutations for different sessions remain concurrent without overwriting one another's entries. Session update events are started in mutation order after canonical state and projections are durable; local subscriber work is not awaited inside the critical section, so an event handler may safely request a later mutation of the same session.

Completion notice record and acknowledgement operations also use a per-session operation queue outside the canonical mutation lock. This keeps completion events ordered with their durable unread-count changes without recursively acquiring the session mutation boundary.

Permanent removal dismantles a session and its descendants under their mutation locks, then releases every lock before publishing child-first `session.deleted` events. `Session.remove()` awaits those publications so subscriber completion or publication failure cannot escape as detached asynchronous work.

These locks coordinate the single runtime process that owns a local Scope. Storage atomic writes remain the durability boundary, but the JSON indexes are derived state rather than a cross-process transaction; startup migrations and rebuild paths recover them from canonical session records when required.

## Completion Notice and the `session.completion` Event

Each session stores a durable `completionNotice` with three fields:

| Field         | Type      | Meaning                                                                          |
| ------------- | --------- | -------------------------------------------------------------------------------- |
| `unread`      | `boolean` | Whether any unacknowledged assistant reply exists.                               |
| `unreadCount` | `number`  | Monotonic counter of assistant terminal replies since last clear.                |
| `silent`      | `boolean` | Suppresses notification counting; set explicitly or inherited by child sessions. |

`silent` can be set when a session is created and otherwise inherits from its parent. Internal background sessions use the explicit flag when their completion should not count as user-visible unread work.

When a root task reaches a normal terminal assistant reply, `Session.recordCompletionNotice()` increments `unreadCount` and sets `unread` to `true`. Successful replies then publish `SessionEvent.Completion` with `{ sessionID, unreadCount }`; error replies retain the durable unread state but publish only `SessionEvent.Error`, preventing duplicate success and error notifications. Archived and silent sessions skip both the increment and completion event. If an aborted run ends before producing any assistant message, its synthetic aborted assistant does not record a completion notice or publish either notification event. `SessionEvent.Error` may also omit `sessionID` for a global invocation failure that was not bound to a session.

The frontend clears one session through `Session.clearCompletionNotice()`, which resets `unread` to `false` and `unreadCount` to `0`. It can also acknowledge a caller-captured count through `Session.acknowledgeCompletionNotice()`: the storage update atomically subtracts only that snapshot, so a completion recorded concurrently remains unread. `POST /global/acknowledge-completions` applies that decrement to every non-archived root session with unread state in the complete global index and excludes child sessions. A stale unread navigation entry is repaired from canonical session state, while an entry whose session cannot be resolved increments `failedSessionCount` without preventing other acknowledgements. Neither acknowledgement path emits `SessionEvent.Completion`.

The `session.completion` event is the durable success-notification signal. It is emitted once per successfully completed root task, independently of the lifecycle `session.idle` event. A session that completes a task, remains busy for additional work, and then finally idles will fire `session.completion` for each successful root task and `session.idle` once when the loop releases ownership.

Legacy persisted records that have `unread === true` and `silent !== true` but lack `unreadCount` are normalized to `unreadCount = 1` at the read boundary and by the persisted `SessionMigration.migrateSessionCompletionNotice` upgrade. Fresh sessions start with `unreadCount = 0`.

## Rollback Feedback Acknowledgment

Rollback history and rollback feedback presentation have separate owners. History events remain the canonical record of rollback and unrollback operations. Optional top-level `Session.Info.rollbackAck` stores only that a client presented feedback for the current rollback, as `{ rollbackID, acknowledgedAt }`.

`POST /session/:sessionID/rollback/ack` accepts only the current active rollback ID. Repeating the same acknowledgment is idempotent and preserves its original timestamp; a stale ID or a session without an active rollback is rejected. A changed `rollbackID` naturally makes a later rollback eligible for feedback without clearing the previous acknowledgment. The write does not require the session to be idle and publishes the normal `session.updated` state event when it changes.

This state is session-global and durable across runtime restart, but it is not imported with a session because history events are not imported. It is presentation state, not a `SessionHistory.Event`, and does not change effective message history or session activity ordering.

Session metadata is not the message transcript. Each has its own storage and events.

### Global identity and endpoint lookup

`sessionID` is globally stable. `Session.get(sessionID)` resolves `data/session_index/<sessionID>` to the owning Scope and then reads `data/sessions/<scopeID>/<sessionID>/info`; callers do not form a composite `(scopeID, sessionID)` identity.

Channel endpoint lookup is a secondary global index from endpoint key to candidate `sessionID` values. The endpoint facade requires the provider's resolved Scope and verifies that the active Session belongs to it. A mismatch fails without moving, reusing, or creating a second Session in another Scope. Endpoint creation and archive share one hashed lock, so one endpoint has at most one active Session while retaining archived history.

New Channel endpoints use typed `chat`, `project`, or `task` targets while existing Feishu records retain their legacy key encoding. A Clarus task target contains the external Project and Task IDs and therefore resolves one stable Task Session inside the owning managed Project Scope. Project targets identify ownership and navigation only; task-only discovery does not create a Project conversation Session.

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

The owner also records an internal execution phase: `queued_agent`, `running_agent`, `authorizing_tools`, `queued_tools`, `running_tools`, `waiting_background`, or `stopping`. These phases drive aggregate runtime diagnostics and do not create a second public session-status contract. The generation is part of Agent-turn ownership and ToolTask identity, so a stale completion cannot release or duplicate work owned by a newer loop.

Agent workers are read/compute-only with respect to canonical session state. `SessionProcessor` in the Control Plane commits streamed parts and ordered events, releases the Agent worker, then schedules proposed tools. Control Plane-owned execution applies authorization before physical execution, and tool results return to the same processor for exactly-once terminal settlement. The persisted assistant/tool parts remain the recovery truth; in-memory Agent and ToolTask queues do not become a second message store.

This single-writer rule supports:

- ordered task execution
- deterministic message and part persistence
- a loop-scoped in-memory model working-set cache
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

Skill slash-command fallback preserves that same root. When a Skill template has no placeholder to consume trailing input, the rendered Skill body and the trailing user input are stored as separate user-origin text parts on the same root user message, before attachments. The fallback does not create a second turn, hidden steer, or system-authored prompt fragment.

`SessionProgress.needsModelCall(messages, R.id)` asks whether the latest user message belonging to `R` has a later terminal assistant reply belonging to the same root. Terminal assistant finishes exclude `tool-calls` and `unknown`, which keep the model/tool loop active.

### Root variant lifecycle

Each task root user message stores an optional `variant` string that selects a reasoning or effort variant for the model call. The variant is resolved once when the root message is created (input acceptance or inbox materialization) and then persisted. Active roots do not re-resolve after config reload.

Resolution priority (first non-empty wins):

1. explicit `variant` from the input payload
2. `agent.defaultVariant` from the resolved agent definition
3. `config.role_variant[modelRole]` from the Models domain configuration

Only task roots (`isRoot = true`) receive a resolved variant. Steer and context messages never expose or materialize a variant. A queued inbox item may retain its internal variant snapshot so promotion back to task mode does not lose intent, while non-task public projections unset the field.

`LLM.prepare()` consumes the persisted `variant` from the root user message. When the variant is absent, no variant options are applied and the provider uses its default behavior.

A persisted variant that is absent from the current enabled model catalog raises `ProviderModelVariantUnavailableError` at `SessionRootVariant.options()` — the runtime does not silently fall back to another variant or unset the field.

`SessionRootVariant.resolve()` validates an explicit candidate variant against the model's declared `variants`. When the model declares variants, an unknown explicit candidate surfaces the same error before persistence so the caller can correct the request. An agent or role default that the selected model does not declare is omitted, letting that provider use its own default rather than persisting an invalid root variant. A model that declares no variants leaves a newly resolved root variant unset.

Legacy task roots that were persisted without a variant are filled by migration `20260726-session-root-variant` when the agent/config defaults can be resolved. Session import applies the same canonicalization to missing imported root variants while preserving explicit values.

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

Full transcript reads run it over the complete ordered raw message list before pagination or slicing so root ownership can be derived consistently. It:

- maps legacy source metadata into canonical `origin`;
- derives `isRoot`, `rootID`, `visible`, and `includeInContext` when absent;
- maps legacy synthetic text into part origin;
- gives assistants the active root when an older record lacks `rootID`.

The LLM loop uses a compaction-aware read boundary instead of materializing the full transcript. It restores chronological message-info order, applies rollback events, locates the latest committed compaction boundary, loads parts only for the boundary root, retained summaries, and active suffix, then derives semantics over that root-anchored working set. Generic `Session.messages()` remains the complete transcript path for UI, export, rollback, fork, and other history consumers.

Downstream loop, compaction, history, and frontend code read canonical fields. They must not recreate the retired metadata heuristics.

When a paginated result contains a non-root message whose root lies outside the page, session history loading adds the missing root record so consumers do not lose task identity.

Transcript consumers use the ordered message array as the chronology. `time.created` records when a message enters the transcript; message IDs provide stable identity and only break ties between messages with the same creation time. Inbox delivery may pre-allocate a message ID before materialization, so loop, rollback, fork, compaction, pagination, and other positional logic must not compare raw message IDs to decide whether one message is before or after another.

## Message Page API

`Session.messagePage()` and `GET /session/:sessionID/message/page` (`operationId: session.messagePage`) provide additive cursor-based pagination over effective session history. The existing `Session.messages()` and `GET /session/:sessionID/message` remain unchanged and are the correct path for runtime loops, export, preview, and flat consumers that need the complete message array or a simple tail slice.

Pagination scans lightweight message info to establish effective history, cursor position, and referenced roots, then hydrates parts only for the selected page and those roots with bounded concurrency. Legacy records whose canonical semantics depend on parts are hydrated during read-time derivation; current records outside the requested page are not.

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

### Derived activity summaries

Assistant messages may persist bounded presentation-only summaries under `metadata.activity`. This derived object has schema version `v: 1`, a per-message monotonic `seq`, optional Activity Trace group entries keyed by the shared deterministic group key, and an optional latest `now` line. Each group entry may carry a `signature` containing its ordered member part IDs. Summary states are `live`, `stable`, or `fallback`; pending presentation is derived locally and is never persisted. The schema v1 optional `reasoning` entries and `now.source: "reasoning"` remain readable for historical messages but are never written; no migration or backfill is performed.

`ActivitySummary` observes the existing part and message events without awaiting model work in the streaming path. For `balanced` and `minimal`, it submits bounded, sessionless calls to the hidden `activity-summary` agent using the `nano` model role, a deny-all permission profile, no retries, and a fixed timeout; `full` does not invoke it. Nano is used only for semantic tool grouping — reasoning summaries are never derived or persisted. For settled ordinary tools (completed or error), one bounded call per flush receives an ordered redacted manifest containing only index, tool name, activity family, hard-boundary segment, and an optional short safe hint such as a basename, URL origin, or command executable. It returns contiguous semantic groups and one user-facing summary per group. Tool inputs, outputs, full paths, full URLs, raw errors, and secrets are never sent.

Text, reasoning, attachment, receipt-tool, and message boundaries are deterministic and cannot be crossed by semantic grouping; reasoning parts remain hard grouping boundaries. An error step remains in its current group, promotes that group to error, and prevents later steps from joining. The backend validates that nano output covers every manifest step exactly once, preserves order, stays within a hard-boundary segment, and respects the 24-step group bound. Invalid output, timeout, provider failure, or a manifest larger than 48 steps fails soft for the entire tail: the backend persists deterministic adjacent family-and-scope groups with `fallback` state, each capped at 24 steps. Stable nano groups carry a concise summary, while fallback groups persist membership only and may omit text. The frontend uses persisted signatures as settled semantic membership, while unpersisted streaming work keeps the same deterministic family-and-scope projection without making model calls.

The stable group key remains anchored to the first member's message ID, family, scope key, and part ID. This preserves historical keys and avoids a schema migration even when a settled semantic group contains multiple families. Activity Trace remains a presentation projection over the original parts: persisted group text and signatures guide internal semantic grouping but do not render as a parent row. Balanced UI renders each original tool call as a flat, independently expandable row with its family action, title, state, result, and specialized content, without a group topic, progress marker, step count, or connector.

Balanced UI derives a presentation-only reasoning status per assistant message: while the turn works after reasoning begins, each working assistant message shows its own pending `Thinking…` row anchored at that message's position; the row disappears once the message completes with assistant text, tool, or receipt output, and a reasoning-only completed turn keeps one generic `Reasoning` fallback. No reasoning text or source is attached. When `compactReasoning` is enabled, each message's working status upgrades into its own live single-line reasoning row, and each settled assistant message keeps one collapsed expandable reasoning row anchored at its original part position instead of suppressing the reasoning. `full` keeps the raw reasoning chronology, while `minimal` keeps its compact presentation without rendering reasoning rows.

Writes go through `Session.updateActivityMetadata`, which compares the expected `seq` inside the owning message-info storage update, merges the group map, advances the sequence, updates `SessionMessageCache`, and publishes the canonical assistant message through the existing `message.updated` event. Stale writers are discarded. No new route, SDK contract, part type, or event is involved.

Activity summaries never rewrite message parts and never enter model-context projection. Provider failure, timeout, cancellation, empty or invalid output, or unavailable nano configuration fails soft: tool activity uses deterministic fallback membership. The session loop continues independently. Because the metadata is additive derived state, existing messages require no migration or historical backfill.

### Assets and attachments

Attachments are durable parts with separate model and presentation policies. Model policy can provide a summary, extracted content, a provider-managed file, or no model input. Presentation policy can select image/video/audio/thumbnail/file rendering, size, crop, or hidden state. Uploads accept any file type; images and extractable documents are sent to the model directly, while other binaries project as a summary plus their durable local path with a tool-inspection hint so the agent can read them through file tools.

Inline data, uploaded bytes, Channel temporary files, and returned tool attachments are externalized to the Asset store as `asset://` references when appropriate. Attachments created from uploaded bytes, inline data, or Channel temporary files carry a `localPath` resolved from their durable Asset ID, so model projection and inbox recovery do not depend on the original upload or temporary file. Plugin Host Service assets use the same durable path; tool-created asset attachments may retain a source workspace path for user-facing provenance. Summary-mode user attachments include their resolved local path in model context, while provider-managed files preserve their explicit local path and provider input. Repeated historical images are deduplicated and bounded during model projection without removing their transcript parts. Asset routes validate IDs inside the Asset root rather than accepting arbitrary filesystem paths.

### Assistant context usage

Assistant messages may include an optional `contextUsage` snapshot for the completed provider call. The snapshot is additive message data, not a separate storage record or session aggregate.

`contextUsage.version` is currently `1`. `totalInput` is the provider-reported exact input token total for that assistant step. The `conversation`, `toolActivity`, `filesReferences`, and `instructions` categories store bounded UTF-8 `estimatedTokens`, reconciled `attributedTokens`, and an optional item count. `overhead.attributedTokens` accounts for exact input tokens that were not attributed to a category. Provider/model identity, optional context and usable-input limits, estimator kind, sampling metadata, reconciliation mode, factor, and capture timestamp travel with the snapshot so the frontend can render it without recomputing prompt assembly.

Older assistant messages that have only `tokens` remain totals-only history. Existing version-1 snapshots with the retired `model-tokenizer` estimator remain valid, while new snapshots use `bounded-utf8`. Read-time canonicalization does not invent a category breakdown, and there is no storage migration or historical backfill for `contextUsage`.

The Side Workspace Context panel reads this field from normal message synchronization. It may fall back to existing assistant token totals for exact latest-call usage, but category breakdown is available only when a persisted `contextUsage` snapshot exists.

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

Stable delivery keys deduplicate inbox items independently from transcript message IDs. Materialization persists the assigned message ID for idempotency, but the ID allocation time does not define transcript chronology. Task, steer, and context order remains stable through `orderKey`; message reads order materialized records by `time.created` with the message ID as a deterministic tie-break.

Typical mappings:

- a new user prompt, Agenda run, Channel request, or Blueprint start uses `task`;
- an active-user interruption, Cortex completion, review rejection, or workflow continuation uses `steer`;
- passive information intended for the next natural model call uses `context`;
- assistant-role cross-session delivery materializes immediately against the latest root.

Ordinary `session.input` acceptance persists a `task` item before scheduling execution, including when the session is idle. After that durable write, acceptance makes a best-effort attempt to advance the session's navigation activity so an existing session returns to the top of recent lists before asynchronous execution starts; a navigation update failure is logged without rejecting the persisted input. The response returns that durable queued item; Scope initialization and the model loop begin asynchronously through `SessionDrive`. Idle `noReply` input retains its direct materialization path because a steer item cannot create an independent root.

The loop peeks the next task without deleting it, materializes its pre-allocated message ID as a root, and commits the inbox item only after that root write succeeds. A failure before materialization therefore leaves the task available for explicit retry or restart recovery. A read taken during startup always sees either the pending inbox item, the materialized root, or both; consumers deduplicate the overlap by message ID.

Channel routing uses these same inbox semantics rather than a provider-specific mailbox. A new external chat request or Clarus assignment uses `task`; a Task update uses a deduplicated `steer`. Clarus participation instructions and Agenda `session_guidance` deadlines are hidden system-origin `steer` messages in the same Task Session. Project discovery, subscription acknowledgements, and other Project-level protocol events do not deliver Session work.

For conversation ingress, Channel core completes durable acceptance before the provider releases its per-conversation lane. An idle Session is accepted by reserving its loop lease before execution starts; a busy Session is accepted by writing a deduplicated `task` item with stable provider message identity and reply correlation metadata. Temporary inbound attachments are converted to durable message parts before acceptance. Provider-local queues remain transient ordering lanes, not recovery state.

Promoting a queued user task to guide/steer changes the inbox mode instead of writing permanent guided/no-reply metadata into the message model.

On abort, steer and context items are discarded while queued task items remain for explicit later execution.

If a loop run fails while runnable inbox work remains, release still yields ownership but does not immediately request another drive cycle. The durable inbox item remains available for an explicit retry or a later delivery-triggered wake instead of entering a tight self-wake loop.

## Message Chronology Index

Message info records remain the canonical transcript and `time.created`, followed by message ID, remains the canonical chronology. `MessageV2.readInfoList()` reconstructs that complete order directly from message info for full-history consumers.

Newest-first bounded readers use the derived `session_message_order_v1` index instead of eagerly parsing every message info. The index stores one sortable marker per message plus a ready/count state record. Message creation, chronology changes, removal, and permanent session deletion maintain it under a per-session write lock. Ordinary streaming updates whose `time.created` value is unchanged do not rewrite marker state.

The index is not part of session export or canonical recovery state. Missing, incomplete, or internally inconsistent index state is rebuilt from canonical message infos before use; a non-ready state left by interruption also forces a rebuild. Consumers must not derive transcript semantics from marker filenames or treat the index as an independent message source.

## Model Context Projection

`MessageV2.projectModelMessages()` projects canonical session history into provider messages and derives category hints from the same emitted branches. `PromptBudgeter.buildPlan()` may transform those messages for the selected provider; before streaming, `SessionInvoke` remaps the hints over the plan's final message array so removed content is not attributed and inserted or rewritten content follows its final role. `MessageV2.toModelMessage()` is the compatibility wrapper for callers that need only the messages.

- messages with `includeInContext = false` are skipped;
- compacted history is filtered at the compaction boundary;
- attachment model policy decides whether an attachment contributes content, summary, provider file data, or nothing;
- only a bounded number of historical images are retained;
- tool calls and results are emitted in provider-compatible order;
- duplicate terminal tool parts from older histories are collapsed by provider call ID, preferring the execution outcome over an AI SDK fallback diagnostic;
- workflow wrappers are applied ephemerally and do not rewrite stored user text.
- errored-assistant filtering, canonical terminal tool selection, attachment fallback text, and historical-image placeholders apply identically to messages and provenance.

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

An interrupted latest reply-required root is repaired through one root-anchored, per-session serialized terminalization primitive shared by startup reconciliation, Abort, and the pre-wake guard. If that root has a non-terminal assistant, repair preserves an existing structured error, fills missing terminal timing, and sets `finish: "error"`; if it has no assistant, repair attaches one aborted terminal assistant to that root. A canonical terminal reply only causes stale `pendingReply` cleanup. Repeating repair is idempotent, and recovery state is surfaced as `recovering` whenever the latest assistant lacks a canonical terminal `finish`, not merely when `time.completed` is absent.

Startup pending-reply reconciliation isolates failures by session. An unreadable history remains pending and is reported as a warning, while recovery continues for other sessions so one corrupt record cannot prevent the global runtime from starting. Ordinary startup recovery terminalizes interrupted roots without invoking the model or tools.

Startup recovery also discovers Sessions that still contain runnable `task` inbox items and requests work through `SessionDrive`. Discovery and drive failures are isolated per Session, and active Session owners are skipped. Recovery never materializes inbox items directly: the ordinary loop remains responsible for peek, root materialization, and commit.

### Abort status synchronization

When a running session is aborted, `signalAbort()` signals the owning controller and sets the phase to `stopping` but does not publish events or repair durable state. The abort HTTP route cancels descendant Cortex work and calls the shared `repairAfterAbort()` terminalization path; the frontend presents local stopping feedback immediately while that request settles.

`repairAfterAbort()` reads `SessionWorking.resolve()` (the same canonical check used at startup) to decide whether the repaired session is truly idle or still has active work (workflows, BlueprintLoops, non-terminal assistants, or pending reply). It then publishes a status-only idle event through `SessionManager.publishStatusOnly()`, which emits `SessionEvent.Status` with `{ type: "idle" }` but never publishes `SessionEvent.Idle`. `SessionManager.wake()` runs the same idempotent repair before entering the model loop so newly queued work cannot revive an older malformed root.

This separation exists because `SessionEvent.Idle` has side-effect consumers — `ContinuationKernel` for automatic loop wakeups — that must not fire for repair-only status corrections. Lifecycle idle (`SessionEvent.Idle`) remains owned exclusively by `SessionManager.release()`, which publishes both `SessionEvent.Status` and `SessionEvent.Idle` when the runtime loop voluntarily yields ownership. Completion notifications are driven by the independent `SessionEvent.Completion` event emitted after each root task produces a terminal reply; they do not depend on `SessionEvent.Idle`.

## Invariants

- A session belongs to one Scope and has one current workspace.
- At most one active loop lease owns a session, including while it is starting or stopping.
- Agent workers never own Session/Message persistence or canonical event sequencing.
- Internal execution phases refine an owned loop without replacing the public busy/retry/idle status contract.
- One root user message owns each task and all assistant messages in that task.
- Root variant is resolved once at persistence and does not drift after config reload; steer and context messages never carry a variant.
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
