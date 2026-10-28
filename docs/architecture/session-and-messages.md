# Sessions and Messages

## Session Contract

A session is the durable unit of work in Synergy. It belongs to one Scope, persists an explicit nullable execution workspace, stores its message history and operational state, and can be resumed by any client connected to the same runtime.

Session metadata batch reads resolve distinct Workspace references through one catalog batch, whose SQL statements are bounded by the storage reader. Projection preserves input order, missing records and Scope ownership checks. The resolved catalog is local to that read, so subsequent reads observe rebinding without a persistent cache. See the [batch hydration decision](../decisions/implemented/bug-fix/2026-09-25-batch-session-workspace-hydration.md).

Session state includes, when applicable:

- Scope, workspace, title, category, timestamps, and archive state
- model and agent overrides
- control profile, permission rules, and pre-authorized actions
- endpoint identity for Channel or other external entrypoints
- parent or fork lineage
- Agenda, Cortex, BlueprintLoop, SuperPlan, or workflow metadata
- inbox, todo, DAG, history, completion, and recovery state

## Session Mutation and Index Projection

Session storage and transcript imports use `Session.PersistedInfo`, which validates the base session fields while preserving optional domain metadata, including unknown workflow kinds and nested fields. `SessionSchemaRegistry` lets each selected owner contribute the public API shape, creation behavior and import cleanup before runtime startup seals registration. Workflow kinds and their request schemas come from the selected descriptors. Unloaded owners do not validate or clear their persisted fields, and persistence tolerance does not add arbitrary fields to the generated SDK contract.

Internal Session reads retain canonical owner metadata. HTTP responses and Session events use `Session.publicInfo()` to expose only registered fields; unknown workflow kinds are omitted before validating the public shape, so an unloaded workflow cannot block an ordinary session read or Scope bootstrap. Archive exports retain the canonical metadata for restoration. Ordinary Session mutations never write a public projection back over retained owner data.

Session mutations use one `Storage.transaction()` for canonical session info and the session, page, child, navigation and endpoint indexes. Nested `Storage.update()` and index writes join that transaction. Activity updates, completion acknowledgements and last-exchange updates therefore commit their state and projections together.

Workspace selection accepts catalog identity and binding generation for both directory and logical storage. A logical Workspace has no native directory projection. Environment selection has its own conditional endpoint and commits the owner binding with Session metadata; ordinary `Session.update` cannot change either authority. Turn admission obtains the Session binding lease before reading its resource context, so a concurrent selection cannot expose partially committed state.

Page and navigation indexes are shared by sessions in a Scope, while child indexes are shared by siblings under one parent. Their read-modify-write operations participate in the same SQL business transaction. Completion notice operations also use a per-session queue outside that transaction to preserve operation order without waiting on another SQL writer from inside the current transaction.

Navigation reconstruction prepares canonical metadata through the central on-access runner in batches of at most 128 owners before acquiring the publication writer. Each owner upgrade and its receipt commit atomically; publication rechecks the index and reads current canonical metadata through `SessionRecords` before applying the current Session schema. Pure owner predicates skip absent metadata without claiming a completed receipt, and dependent predicates observe preceding upgrades. Reconstruction preserves conversation timestamps and unknown owner metadata without hydrating messages or rollout evidence. Historical body preparation and pause-recovery enrollment belong to explicit Session access. A versioned derived migration repairs previously persisted incomplete indexes; its deferred-owner path upgrades and publishes only the admitted Session.

Navigation index version 2 records the sorted Session owner IDs and workflow kinds that produced their identity fields. A composition change reconstructs resident membership from indexed canonical Session keys while retaining existing activity cursors, including when the saved index is partial. Uninstall and reinstall hide and restore owner identity without expanding deferred Session admission. Ordinary mutations preserve an outdated composition marker and cannot publish a complete index from one newly created Session. The central record migration invalidates version 1 composition markers on access so retained partial indexes are reconstructed. Storage failures propagate rather than establishing an empty index. See the [navigation admission decision](../decisions/implemented/bug-fix/2026-10-17-cold-navigation-metadata-admission.md).

Event publication inside a transaction records a durable pending notification with the state change. Dispatch and cache effects run after commit. The storage and recovery behavior is defined in [Agent storage](agent-storage.md).

Permanent removal drains pending part writes, then removes the session and its descendants, updates their indexes, registers snapshot cleanup and records child-first deletion notifications in one transaction. Runtime caches are cleared after commit, followed by workspace detachment and snapshot cleanup. Startup migrations and transfer recovery rebuild derived indexes from canonical session records; archived retired endpoint metadata remains in those records without recreating retired routing projections.

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

`sessionID` is stable within its owning Runtime storage. Independent Runtime instances may contain identical session IDs without sharing state. `Session.get(sessionID)` resolves the logical key `["session_index", sessionID]` to the owning Scope and then reads `["sessions", scopeID, sessionID, "info"]` through the storage Handle; callers do not form a composite `(scopeID, sessionID)` identity.

Channel endpoint lookup is a secondary global index from endpoint key to candidate `sessionID` values. The endpoint facade requires the provider's resolved Scope and verifies that the active Session belongs to it. A mismatch fails without moving, reusing, or creating a second Session in another Scope. Endpoint creation and archive share one hashed lock, so one endpoint has at most one active Session while retaining archived history.

New Channel endpoints use typed `chat`, `project`, or `task` targets while existing Feishu records retain their legacy key encoding. A Channel task target contains the external Project and Task IDs and therefore resolves one stable Task Session inside the owning managed Project Scope. Project targets identify ownership and navigation only; task-only discovery does not create a Project conversation Session.

## Session Lineage

Synergy records two different relationships:

| Field        | Meaning                                                           |
| ------------ | ----------------------------------------------------------------- |
| `parentID`   | Runtime child ownership, primarily delegated/background sessions. |
| `forkedFrom` | A user-visible history fork copied from another session.          |

A fork is not a child task. It copies the source session's effective history and records `forkedFrom`; it does not use `parentID` to imitate delegation.

Default fork titles inherit the source name with an available numbered suffix, allocated in the same transaction as publication using the Scope navigation index. `forkedFrom.generatedTitle` identifies an unchanged automatic name for nested numbering; renaming clears it, and absent historical markers are not inferred. The destination Workspace is selected independently through the existing Workspace selection API. Fork does not restore or copy code. See [session-fork destinations and naming](../decisions/implemented/feature/2026-10-26-session-fork-working-location.md).

Child sessions inherit the parent Scope, nullable workspace and interaction context by default, even when creation runs under another ambient Scope. Their effective control profile is resolved through the parent chain rather than copied as an independent root profile.

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

The durable session can outlive its in-memory runtime. Runtime state is reconstructed from persisted messages, the `paused` latch, workflow records, BlueprintLoop state, and recovery metadata after restart. A restart never resumes work: every session that ended abnormally is recorded as paused and waits for an explicit Continue or Abandon.

`SessionResume` admits explicit Continue under the Session control lock. The optional request identity and observed pause identify one recovery intent; an older intent cannot release a newer pause. Inbox delivery, the `resume` receipt, Rollout reopening and pause release commit atomically. The HTTP result reports `accepted`, `already_accepted`, `running`, `idle`, `stale` or `blocked` after admission, independently of model execution. The receipt retains the task, message and Inbox identities with `queued`, `consumed` or `cancelled` state and is readable with Session metadata. Historical Sessions without a receipt use the same admission path. Recovery preserves prior failures and completed effects and injects input into the original root; a queued next task does not reopen its completed predecessor. Restart recovery counts an unanswered continuation even after an earlier terminal reply. See [the recovery decision](../decisions/implemented/bug-fix/2026-10-23-durable-session-continue.md).

Stopping an execution or replying to its pending question or permission request is a control operation, not another execution turn. These operations bind the target Scope and Workspace without acquiring a second loop lease. An agent abort request carries its caller's cancellation signal into control-lock admission, so a cancelled old call cannot acquire that lock later and stop newly admitted input. Compaction and worktree changes still require exclusive execution admission. A tool that pauses its own execution persists its successful result before signalling the original lease through `afterPersist`; that hook cannot wait for a control lock held by input awaiting the same lease. Failed tool settlement also signals an already-paused original owner, allowing same-batch waiting tools to drain when result processing prevents the hook. The invoke loop checks the durable pause before each subsequent model turn as well.

## Durable input recovery

Startup Inbox discovery skips corrupt records and unreadable Session owners, including missing derived indexes, while continuing to healthy owners. Storage outages still propagate; discovery never removes retained work or bypasses execution-owner availability. Owner checks use effective message metadata and canonical rollback semantics; they do not hydrate bodies or start owner migrations inside a read snapshot.

A client-supplied message ID identifies one input. `input` and idle `noReply` acknowledge only after durable Inbox admission. Idle passive input retains its internal admission marker through recovery and materializes without opening an LLM turn or clearing a pause. Concurrent retries share a deterministic Inbox item, and materialization, removal and restoration receipts and durable cancellation markers prevent reinsertion after completion or cancellation. Explicit Inbox retry clears its failure and the session pause under the session control lock; task retry does not reopen an unrelated old root. A newly queued task advances past historical roots without execution evidence and terminal roots before resolving configuration, so an unavailable historical model cannot own the new task.

Input to a paused Session steers its latest root only when canonical message headers still show an unfinished reply. A late stop after completion does not make that completed Rollout resumable; the next input starts a new task. Pause reads preserve storage admission and integrity failures instead of treating them as an absent latch. Reply selection for a new task never falls back to an assistant owned by an earlier root.

`GET /session/{sessionID}/input/{messageID}/status` projects the durable Inbox item, canonical message and Rollout run in one storage snapshot. States are `accepted`, `preparing`, `queued_storage`, `materializing`, `running`, `retrying`, `completed`, `cancelled`, `removed` and `failed`. Scheduling and queue detail is bounded Runtime-local telemetry published through the coalescible `session.input.progress` event; it is not another durable message state machine. Exhausted scheduling retries park the saved task. A paused saved input requires explicit retry and reports `SessionPaused`; time spent waiting alone never declares failure. Inbox admission does not create a running Rollout. Configuration is prepared before message materialization; the transaction validates the Inbox revision and cancellation marker before committing the root and receipt, then attaches execution configuration. A second cancellation check precedes execution. A begun run can remain open through detached settlement; task activity and its primary outcome are projected from independent execution evidence. Abandon settles the latest root even when its execution was already paused.

### Execution time

Rollout owns independent monotonic execution intervals associated with the owner, run, file-change segment and execution branch. The runtime supplies one clock identity. Opening, blocking, resuming and closing persist interval boundaries; elapsed display never writes periodic records. Model waits, generation, foreground compaction and actual tool work count. Human input suspends only its branch, and a coordinator waiting on tools or Cortex work does not add a covering interval. Auxiliary title and summary work retains accounting but cannot extend execution time. Closed branches cannot resume after late replies or an aborted execution generation.

The aggregate unions all selected root and descendant intervals within each runtime clock and sums confirmed groups across runtimes. Missing evidence returns `elapsedLowerBound`; a missing crash tail contributes zero rather than downtime. Recovery stores `detectedAt` independently of an unobserved end. The versioned Rollout execution migration appends corrections for admission-only legacy runs and backfills confirmed model transport spans, conservatively retaining partial coverage when branch boundaries were not recorded. Original journal revisions remain replayable. The central registry schedules the upgrade only for requested Session or operation owners. It reads current per-run records instead of replaying the owner journal, preserves `timingVersion` checkpoints, and leaves original journal revisions unchanged. Archive import invokes the same owner transform; snapshot checkpoints are discardable projections.

### Inbox removal and restoration

User removal moves the complete stored Inbox item into a session-owned recovery record in the same transaction as its queue removal. Internal consumption and cancellation keep their existing hard-removal paths. The removed-items API exposes only the ordinary public item projection. Restoration requeues the canonical stored item with its original mode, message ID, input and execution configuration; it cannot reconstruct an item from presentation data. A retained restoration receipt prevents a repeated restore request from resurrecting consumed input. Completed or cancelled runs cannot be restored. Restore schedules ordinary queue processing without clearing a pause or rearming a failed item; Continue and Retry remain explicit controls.

Recovery records belong to the Session and are deleted with it. Whole-Home transfer preserves them; transcript exports and session forks exclude queue/recovery state. Existing installations require no rewrite because the collection is additive and absent means empty.

## Task Roots

A session processes a serial sequence of tasks. One root user message `R` owns each task.

Execution ownership is distinct from retained Session metadata. Resume and queue consumption require the selected owners of the root, injected messages and bound operation. A new ordinary human task admitted while the previous task cannot resume receives a host-written `execution: { version: 1, kind: "independent", previousRootID? }` marker. Inbox admission persists that decision before acknowledgement; materialization commits the marker with its canonical user message and receipt. Clients cannot supply it through the input API. Missing markers retain the existing ownership rules.

Admission resolves an independent task's implicit Agent against the current registry and retains a usable inherited choice. If that inherited Agent is absent, the task records the current default Agent before acknowledgement. An explicit unavailable Agent still fails validation. Stored Session overrides and earlier roots retain their original choices.

The default Agent is a selectable `default_agent` from resolved Scope configuration, otherwise the lightweight primary (Pico), otherwise another visible primary. The Agent catalog puts that selectable default first so a fresh Web composer agrees with implicit backend execution. Explicit composer choices and existing Session history retain priority; changing the fallback does not rewrite saved selections.

An independent root uses an in-memory base Session view without old workflow or component extensions for configuration, instructions, tools and continuation. Canonical Session fields, earlier rollout evidence and unavailable queued work remain stored. Reinstall does not reattach the old operation to that root. Owner-authored steer and context messages cannot enter it; separate owner tasks remain queued for their normal lifecycle after the independent task finishes. Its model projection removes system-authored parts from earlier non-root owner control messages while retaining human and Channel text and attachments. Stored history and its public presentation remain unchanged. Continue resumes the same independent root after interruption or restart.

- `R.isRoot = true`
- `R.rootID = R.id`
- non-root user injections for that task keep `rootID = R.id`
- every assistant message produced for the task has `rootID = R.id`
- newly written assistant messages also use `parentID = R.id`

The loop does not change ownership when a user steers it, a Cortex task reports back, compaction continues, or a workflow injects control context.

Skill slash-command fallback preserves that same root. When a Skill template has no placeholder to consume trailing input, the rendered Skill body and the trailing user input are stored as separate user-origin text parts on the same root user message, before attachments. The fallback does not create a second turn, hidden steer, or system-authored prompt fragment.

`SessionProgress.needsModelCall(messages, R.id)` asks whether the latest user message belonging to `R` has a later terminal assistant reply belonging to the same root. Terminal assistant finishes exclude `tool-calls` and `unknown`, which keep the model/tool loop active.

### Model and thinking selection

Session `modelSelection` stores a revision, an atomic model/thinking choice, per-model thinking preferences, the last request snapshot and an optional pending reason. Thinking is explicitly `provider-default`, `off` or a named `variant`. The HTTP `session.setModelSelection` operation validates against the session's Scope and uses an expected revision to reject stale edits. Updates publish through the established `session.updated` event; `modelOverride` remains a compatibility projection for older callers.

A new root without a saved session choice resolves its initial variant in this order:

1. explicit thinking selection or legacy `variant` from the input payload
2. supported `agent.defaultVariant` from the resolved agent definition
3. supported `config.role_variant[modelRole]` from the Models domain configuration

Only task roots receive initial thinking metadata. Steer and context messages never expose or materialize variant or thinking fields. A queued inbox item can retain its internal choice for promotion back to task mode. Ordinary Web submissions reuse the saved selection instead of submitting a potentially stale model/variant copy.

Every model request captures a complete selection before model-dependent preparation. The transient user envelope carries the captured model and thinking; historical roots remain unchanged. The assistant message and rollout request record the captured revision and choice. Changes arriving after capture remain pending for the next request. A restricted Anthropic tool-turn transition remains pending until a new root. Existing streams and completed tools are not restarted.

Switching to a previously used model restores its session preference; first use selects provider-default. Default bypasses agent and role defaults and removes reasoning overrides after ordinary parameter hooks. Off is only offered for a concrete supported disable mapping or an explicit configured variant. Invalid explicit choices raise structured errors without silently selecting another level.

New selections reject unavailable models, unsupported external-agent controls and active-task attachments the target model cannot consume. Cross-model history keeps assistant text and tool results while omitting another model's reasoning blocks. Compression and sessionless calls retain their own model options; a parent selection does not modify child-session preferences.

Migration `20260923-session-model-selection` initializes existing sessions from the explicit model override and stored root choices, including per-model preferences. Import uses the same legacy conversion when the export lacks a selection. Browser-only null sentinels are not promoted into provider-default commands. See the [decision record](../decisions/implemented/feature/2026-09-23-live-model-thinking-selection.md).

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

`origin.detail: "runtime-context"` identifies durable advisory observations. They have `isRoot: false`, `visible: false`, `includeInContext: true`, a canonical task `rootID`, and versioned `metadata.runtimeContext` with source identities, permission role, scope, states and revisions. Format v2 adds state/knowledge/event kinds and verified source-block ranges for deduplication and context attribution. The session-owned migration upgrades v1 metadata without rewriting message text; legacy sources remain state sources. Their text parts use system origin while model projection preserves the user permission role. The [LLM loop](llm-loop.md) owns collection, admission and observation order.

Non-root origins that receive dedicated frontend chips are Cortex, Agenda, Blueprint, Channel, Agent, and Plugin. Rendering remains governed by `visible` plus the registered special renderers.

### Part origin

Text parts use `origin: "user" | "system"`. `MessageV2.isSystemPart()` is the canonical predicate. It also understands legacy `synthetic` parts at the read boundary.

Part origin answers who authored the text. It does not remove the part from model context. Message `includeInContext` and attachment model policy own context inclusion.

## Read-Time Canonicalization

`SessionCorpus` provides paginated installation-wide Session/message enumeration, mixed CJK/ASCII text retrieval, versioned batch hydration and canonical neighboring turns. It reuses the history text projection and its deferred preparation; origin filtering continues beyond rejected hits. Fork ancestry and source versions accompany evidence rather than defining user identity. Generic `metadata.assistance` records accepted completion producers and fingerprints without changing origin, root semantics or required owners; original-voice consumers exclude an assisted submission as a whole.

`SessionContextSnapshot.capture()` supplies immutable, compaction-aware message material for read-only derived calls after a successful root. It requires a completed Rollout and a matching terminal assistant, captures model selection and canonical source revisions in one short read snapshot, and releases storage before inference. `isCurrent()` checks batched revisions, including message ordering and part membership, without hydrating message bodies. Failed, cancelled, unfinished, child and initial-idle Sessions are ineligible. Historical records without a completed Rollout cannot establish this completion anchor.

Persisted histories may contain older metadata shapes. `MessageV2.deriveSemantics()` is the only read-time derivation for canonical message fields.

Full transcript reads run it over the complete ordered raw message list before pagination or slicing so root ownership can be derived consistently. It:

- maps legacy source metadata into canonical `origin`;
- derives `isRoot`, `rootID`, `visible`, and `includeInContext` when absent;
- maps legacy synthetic text into part origin;
- gives assistants the active root when an older record lacks `rootID`.

The LLM loop uses a compaction-aware read boundary instead of materializing the full transcript. It restores chronological message-info order, applies rollback events, locates the latest committed compaction boundary, loads parts only for the boundary root, retained summaries, and active suffix, then derives semantics over that root-anchored working set. Generic `Session.messages()` remains the complete transcript path for UI, export, rollback, fork, and other history consumers.

Part hydration concurrency is bounded. Full-history model loading resolves its selected set first, then hydrates parts through the same declared concurrency window pagination uses. Total body work still depends on the selected set and its sizes. The authoritative storage queue rejects rather than waits once its depth is reached, so unbounded fan-out could fail one large session and starve other sessions.

Newest-first streaming propagates message-info and part hydration failures. Only a missing message-info record after the chronology snapshot may be skipped; an unavailable or corrupt record cannot be presented as a successfully loaded history with evidence omitted.

Downstream loop, compaction, history, and frontend code read canonical fields. They must not recreate the retired metadata heuristics.

When a paginated result contains a non-root message whose root lies outside the page, session history loading adds the missing root record so consumers do not lose task identity.

Transcript consumers use the ordered message array as the chronology. `time.created` records when a message enters the transcript; message IDs provide stable identity and only break ties between messages with the same creation time. Inbox delivery may pre-allocate a message ID before materialization, so loop, rollback, fork, compaction, pagination, and other positional logic must not compare raw message IDs to decide whether one message is before or after another.

Opening the latest display window uses pages of immediate message-order keys. Hydrating selected message bodies validates only those canonical message records and their display headers; it does not prepare a neighboring history window for every requested message. Rollback visibility, content versions and on-access semantic upgrades remain authoritative.

## Message Page API

`Session.messagePage()` and `GET /session/:sessionID/message/page` (`operationId: session.messagePage`) provide additive cursor-based pagination over effective session history. The existing `Session.messages()` and `GET /session/:sessionID/message` remain unchanged and are the correct path for runtime loops, export, preview, and flat consumers that need the complete message array or a simple tail slice.

Pagination and finite `messages` queries establish the effective or raw header view, select their window and referenced roots, then hydrate only that selection with bounded concurrency. Canonical legacy semantic derivation accepts Part metadata without loading streaming bodies. Repair shares a model header view with canonical tool-candidate settlement; rollout reconciliation uses complete effective headers so compaction cannot hide completed roots. The zero-policy continuation gate returns before reading history after provider draining.

Last-exchange refresh computes exact 200-code-unit text previews outside SQL transactions. Short snapshots capture header, ordering and Part-membership revisions; a short writer validates those sources and merges the preview without changing recency or publishing conversation activity. Concurrent requests coalesce per Runtime and Session. Source changes retry, Session deletion stops publication, and unchanged-source artifact failures remain errors. Callers must invoke this operation outside transactions.

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

Tool output and metadata previews are bounded before message persistence. Completed tool output is first archived under the session's private rollout storage and referenced by `state.outputArtifact`; the reference survives context pruning. Pruning records the compacted timestamp without clearing the persisted observation. Model conversion continues to substitute the existing compacted-result placeholder. Forks copy referenced output into the new owner before publishing copied parts, so deleting the source cannot corrupt the fork.

Tool parts carry an optional timeout observation at `state.metadata.toolTimeout`, produced by `packages/harness/src/tool/timeout.ts` and typed once in `packages/util/src/tool-timeout.ts` (imported by both the runtime and the shared UI, which may not import runtime-private modules). `toolTimeoutMs` is the execution budget that aborts the call; `displayMs` is the smaller operation window currently in force; `source` names what that window is. Field names keep their `Ms` suffix because the object is persisted on parts — renaming would strand the observation on historical parts. Seconds are the unit at the agent- and human-facing boundary only.

A countdown renders only from a real server anchor. `running` carries `time.start`; `pending` and `generating` carry no `time` at all, so no countdown is shown before execution begins, and the runtime never fabricates an anchor for a state that has none. The window's meaning comes from `source`: `auto_background` windows hand the process to the background and the tool keeps running, so they are labelled as such and never as a timeout; only `tool_timeout` aborts.

### Tool intent and activity evidence

The public model-tool facade adds optional `workBrief` to each request-frozen definition, including discovered, dynamic plugin and MCP tools. A plain object admits the field directly; conflicting names, root references and composed or non-object schemas use `{ workBrief, toolInput }` with preserved native references. Canonical tool parts retain trimmed intent and the input shape separately from business input. Execution, authorization, fingerprints and repeated-call comparisons consume business input. The invocation context exposes intent to operation-title consumers; tool authors do not declare it. Model history reconstructs the facade, while raw rollout audit bytes retain the original request. Missing intent never triggers a summary model call or blocks execution.

Tool-owning domains register historical field mappings through `Tool.registerInputHistory`; the central versioned Session migration upgrades parts without altering entity storage, ordinary HTTP contracts or audit bytes. Bash's historical call description becomes common intent. Migrations preserve explicit current fields and never invent intent, read snapshots or success facts. Part preparation masks registered secrets in common intent before storage and publication; precise entity text fields retain the provider-payload masking boundary without modifying binary content or raw audit evidence.

Optional `ToolActivityEvidence` identifies operation-time resources, Workspace generation, captured ranges, Artifact content references, truncation and process facts. File reads and searches capture only the actual observation. Activity queries never reopen the current file as historical evidence. Large content stays in existing private Artifacts, process output and file-change ledgers; the message projection contains references. Scope-aware tool queries check message, part and call identity, bound result bytes and retain secret handling. Missing historical evidence is explicit and distinct from no changes.

### Activity presentation

All display modes consume one ordered projection with turn process, bounded consecutive mixed-tool batches and flat selectable rows. Text, Scope, approvals, receipts, deliverables and dedicated renderers preserve boundaries; stable message/part IDs own keys. Statistics count confirmed successful operations; unique file counts require qualified resource identity, with operation counts otherwise. No presentation inference or generated tool summary runs. Action/object facts label tool rows by default; the optional `preferWorkBrief` display preference prioritizes recorded intent when non-empty and retains the existing label otherwise. One secondary entrance per turn exposes raw reasoning in its original order; preview is opt-in.

Part summaries expose an optional `reasoningKey` derived from one unambiguous provider namespace and `metadata.itemId`, without encrypted provider content. Whitespace-only reasoning has `render: false`. Continuous visible reasoning Parts in the same assistant message share one disclosure anchored to the first Part, independent of provider item IDs or missing metadata. Text, tools, attachments and assistant message changes end that group. Summary anchors are established before body chunking; mounted chunks share expansion state without repeating the leading trigger. Canonical stream IDs, Part IDs, text and model context remain unchanged. See [continuous reasoning disclosure](../decisions/implemented/bug-fix/2026-10-11-continuous-reasoning-disclosure.md) and [reasoning summary identity](../decisions/implemented/bug-fix/2026-10-05-group-continuous-reasoning-item-fragments.md).

`MessageV2.summarizePart()` sets reasoning `PartSummary.render` to false when trimmed text is empty. Canonical Parts and encrypted provider metadata remain intact; execution state owns waiting presentation. Failed or pending body reads are distinct from successfully loaded empty text. The Session migrations `20261005-session-reasoning-display` and its dependent `20261005-reasoning-display-identity` share bounded owner-local metadata invalidation: prepared or partially prepared summaries become unprepared, generation increments and preparation cursors are removed. Already invalidated metadata is unchanged on repeated upgrades and imports. Existing display pagination rebuilds the index without reading or altering canonical bodies during migration.

`TurnExecutionState` derives each root's foreground state and stopped execution segments from the rollout ledger, canonical terminal reply and root-owned pending approvals. An ended execution segment can expose reply completion while detached Library or title work keeps the Run open for accounting. Pending workflow work, steering, active segments and unsettled owning Cortex children prevent early completion. A reply predating the latest segment cannot complete a resumed turn; cancelled and interrupted outcomes retain precedence. Completion timestamps establish outcome only; displayed elapsed time comes from the canonical execution-interval projection, including its partial-coverage marker. `SessionHistory.turnCompletion` reads canonical message metadata through the chronology index, honors rollback visibility and does not hydrate response bodies. Historical reads stop at the Run's recorded end. See [foreground reply completion](../decisions/implemented/bug-fix/2026-10-09-foreground-reply-completion.md).

Session-wide status and historical tool errors cannot replace root outcome. A returned background tool and its process retain separate states. Finishing an execution segment publishes the existing root activity event once after its durable write. Selected process output invalidates its own activity through the existing scoped event connection; root updates replay through the same channel. Batch root-status and single-tool result queries are bounded, lazy generated SDK reads.

### Resource reference origins

New messages capture `referenceContext` at admission: a Workspace ID, binding generation, root and relative directory, or an explicit absent/unresolved state. Queued inputs keep that origin through later materialization. File and symbol attachment sources may carry their own Workspace; file sources may also carry a location. Composer editing, storage and export/import preserve this information. The versioned Session migration infers legacy origins only from matching recorded message paths and snapshot evidence, invalidates derived display indexes and leaves ambiguous history unresolved. Import uses the same conversion. Model byte projection is independent of this display metadata; [Workspace and files](workspace-and-files.md#message-resource-opening) owns opening behavior.

### Assets and attachments

Attachments are durable parts with separate model and presentation policies. Model policy can provide a summary, extracted content, a provider-managed file, or no model input. Presentation policy can select image/video/audio/thumbnail/file rendering, size, crop, or hidden state. Uploads accept any file type; images and extractable documents are sent to the model directly, while other binaries project as a summary plus their durable local path with a tool-inspection hint so the agent can read them through file tools.

Managed attachment bytes use immutable `asset://` references independently of model policy. Inline data, uploaded bytes, Channel temporary files and tool-returned data URLs converge through the existing attachment normalization boundary. Plugin Host Service assets use the same store; tool-created attachments may retain a source Workspace path for provenance. Model context carries the same Asset reference for reuse in responses, plus the managed local path when inspection needs it. Provider-file policy keeps binary input eligible during projection; `AgentTurn` resolves eligible Asset references to transient data URLs before request recording and provider dispatch. Persisted Parts retain the Asset reference. Missing or invalid references fail before dispatch, and cancellation propagates through materialization. Remote provider file URLs retain their existing transport. Repeated historical images are deduplicated and bounded during model projection without removing their transcript parts. Asset routes validate IDs inside the Asset root rather than accepting arbitrary filesystem paths. See [attachment resource references](../decisions/implemented/architecture/2026-10-07-attachment-resource-references.md).

At that same `AgentTurn` preparation step, local image Assets, inline data, binary image/file parts and image media inside tool results share `AttachmentImageInput`. Harness owns the budget and Runtime-scoped processor registration; Local Runtime supplies lazy native decoding. Provider copies fit a 2048-pixel longest edge, 2500 patches of 32×32 pixels and 4 MiB of encoded bytes, without enlarging or overwriting the source. Input decoding is limited to 64 MiB and 100 million pixels. The processor validates pixel data, detects the actual format, normalizes EXIF orientation and converts unsupported provider encodings to an 8-bit PNG; valid small PNG/JPEG/WebP inputs can retain their exact bytes. Resizing adds original and transmitted dimensions to model context. Decode, conversion and budget failures replace only that image with explicit text so the remaining conversation can proceed; cancellation, Asset integrity/storage errors and recording failures remain fatal. A host without the processor emits an explicit unavailable-image placeholder. HTTP(S) references in image/file parts keep provider transport; tool-result media accepts base64, so URL strings in that field become invalid-image omissions. Native work is serialized per Runtime and successful prepared results use a bounded memory cache. Failed preparations are retried on later turns rather than cached, so temporary decoder failures can recover. See [bounded model image input](../decisions/implemented/bug-fix/2026-10-11-bounded-model-image-input.md).

Markdown images and links use the same validated Asset references as tool and upload attachments. The streaming and settled renderers preserve those references for the host resource resolver; inserted virtual document blocks use the same binding. Images open the shared preview, and documents open the shared reader from immutable bytes without requiring the original message body. Existing located attachments retain their provenance lookup. The resource registry also accepts the canonical reference. Readers restore focus to the current link when terminal rendering replaced its DOM node.

The shared `presentation.purpose` contract distinguishes inspection `evidence` from a `deliverable`; omitted purpose defaults to a deliverable independently of model policy. `Session.preparePart()` materializes that default for standalone and completed-tool attachments before persistence, cache updates and publication, preserving explicit purpose and other presentation fields. Inspection tools mark their images and documents as evidence, while generation tools produce deliverables. Part summaries carry only visible attachment counts by purpose and the canonical tool display classification, so virtualized history can place content without hydrating tool payloads. The Session migration `20261007-attachment-presentation` converts legacy delivery metadata and known inspection results in bounded owner-local transactions, then invalidates derived display summaries. Imported parts pass through the central record upgrader before current write preparation; runtime consumers do not repeat the legacy heuristic.

There is no separate attachment-delivery tool. Generation results return attachments directly. Bash/process capture supported Workspace files referenced in their output through the existing bounded discovery path and the shared attachment constructor. The common model-preparation guidance asks the agent to embed returned image references beside its explanation and link document references proactively. Image analysis retains the immutable original supplied to its vision child as inspection evidence; the child's provider copy follows the same image budget. Document scanning also retains its original. Showing the original does not require another model-facing option or operation.

Managed Asset and media files are Runtime resources, independent of a session's Workspace. Input preparation reads their bytes directly after checking canonical path containment; native file references require a resolved Workspace and retain Workspace-owned read evidence. Text uploads contribute their decoded body, documents use the registered extractor, and audio/video retain binary data with a summary. An explicit model policy takes precedence over automatic extraction for every source protocol; `content` without embedded text requests extraction and preserves native file selections; filename, presentation and metadata survive normalization. `scan_document` and `look_at` share the managed-path resolver, and vision child input carries durable attachment bytes.

Attachment preparation settles all sibling operations before publishing a message or reporting failure. Missing, invalid or unprocessable attachments park the complete original input with a safe filename-based reason; no partial message reaches the model. Failed steer/context inputs are parked without aborting the active root. Storage pressure, cancellation and evidence-recording failures retain their existing classifications. Scheduling progress identifies the exact message and inbox item, and exhausting its preparation retries parks only that item before driving other runnable work. See the [attachment preparation decision](../decisions/implemented/bug-fix/2026-09-28-workspace-independent-attachments.md).

Text uploads retain UTF-8 replacement decoding for invalid byte sequences, with the original bytes stored in the attachment. Encoding detection is not part of preparation; legacy text bytes do not reject the whole input.

Text extraction preserves the original attachment identity, presentation and immutable bytes for every document type and source protocol. Extracted system text augments model input; it cannot remove the original part from the transcript. The attachment's model policy determines whether binary content is sent to the provider independently of whether the file remains visible.

### Assistant context usage

Assistant messages may include an optional `contextUsage` snapshot for the completed provider call. The snapshot is additive message data, not a separate storage record or session aggregate.

`contextUsage.version` is currently `1`. `totalInput` is the provider-reported exact input token total for that assistant step. The `conversation`, `toolActivity`, `filesReferences`, and `instructions` categories store bounded UTF-8 `estimatedTokens`, reconciled `attributedTokens`, and an optional item count. `overhead.attributedTokens` accounts for exact input tokens that were not attributed to a category. Provider/model identity, optional context and usable-input limits, estimator kind, sampling metadata, reconciliation mode, factor, and capture timestamp travel with the snapshot so the frontend can render it without recomputing prompt assembly.

Older assistant messages that have only `tokens` remain totals-only history. Existing version-1 snapshots with the retired `model-tokenizer` estimator remain valid, while new snapshots use `bounded-utf8`. Read-time canonicalization does not invent a category breakdown, and there is no storage migration or historical backfill for `contextUsage`.

The Side Workspace Context panel reads this field from normal message synchronization. It may fall back to existing assistant token totals for exact latest-call usage, but category breakdown is available only when a persisted `contextUsage` snapshot exists.

## Turn Diffs

Session file history describes workspace net changes during execution, including user and external-process writes. It does not infer an author from a tool result. `SessionFileChanges` captures one baseline before execution and one endpoint when an execution segment finishes, fails or stops. A workspace first used later in the segment receives its baseline before that use. Each system `patch` part carries `checkpoint.version = 1`, root and segment identities, capture timestamps, source Workspace identity/generation, immutable tree references and capture omissions. Checkpoints do not enter model input.

Continuation retains the root's first baseline and appends a new execution segment. A new root receives a new baseline. `SnapshotRanges.net` compares the earliest baseline with the latest available endpoint for each Workspace binding. The session comparison spans each binding's first baseline and latest endpoint; it does not sum operation statistics. Restoring a file to its baseline removes its net difference. Independent workspaces with equal relative filenames remain separate.

Native Workspace invalidations feed a coalesced Session observer with one capture in flight. Dirty capture and lightweight statistics use the same effective path set, including recorded or omitted file ancestors affected by file/directory replacement. A revision reuses unaffected statistics from its predecessor and compares changed paths against the original baseline; broad invalidations, ignore changes and failed refresh recovery request full calibration. Live trees and their cached statistics remain Runtime-owned, with immutable read leases and no durable intermediate roots. Object Workspaces without native observation retain checkpoint-only behavior.

Background process ownership and save receipts remain with the Runtime. A segment endpoint freezes only the bytes observed during that capture, without waiting for background completion. Later process writes cannot revise that endpoint; another segment may capture them. Concrete tool evidence remains owned by its tool domain and is not inferred from the workspace comparison.

### Settlement and synchronization

Both the user message and session summary carry `diffState` and optional `diffIssues`. The turn's `summary.diffs` is a bounded metadata projection. `diffTotals` covers the complete comparison independently of that projection; `diffRevision` identifies Runtime-owned live evidence. Session totals and the existing session Diff query use the same net comparison.

| State     | Meaning                                                                                                                       |
| --------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `live`    | Native Workspace observation is active. An optional code marks unavailable or incomplete coverage.                            |
| `pending` | Comparison is in progress. `deadlineAt` is a server recovery marker; existing results remain visible.                         |
| `ready`   | The configured capture scope was recorded, including a verified empty net change.                                             |
| `partial` | Usable comparisons exist, with identified missing workspaces or files.                                                        |
| `error`   | The current change set cannot be established; last recorded evidence may remain readable. This is not evidence of no changes. |

Safe issue codes distinguish unavailable baselines, capture failures, interrupted execution, legacy ranges, comparison failures, file read failures and size limits. A preview's truncation does not make its retained source incomplete. Capture omissions exclude affected paths from full statistics, historical detail and restoration; available files remain visible. An unavailable workspace comparison preserves its previous displayed evidence. A failed initial capture cannot acquire a replacement baseline from later filesystem contents.

File comparisons run FIFO per session and coalesce duplicate root/revision jobs. Their queue releases before title/body inference; same-root model summaries retain their own publication order across diff-only jobs. Completion without live evidence schedules diff-only settlement through `LoopJob`; live evidence remains until final publication is accepted. Partial title/body writes merge atomically with current file evidence, and inference timeout does not invalidate settled comparisons. Summary reads hydrate the requested root only and extend the aggregate cursor; a missing cursor requires owner-local reconstruction. Pending checkpoint parts are refreshed before comparison. `message.updated` publishes turn settlement; `session.updated` and the established session Diff event publish session projections. Clients do not infer failure from their own clock or issue requests for every streamed token.

Foreground segment completion is persisted and published before endpoint capture. The execution lease retains capture ownership until checkpoints are published, preserving the next segment's baseline ordering. Terminal buffered Part writes flush only the owning Session. Paired snapshot roots share one bounded cache-object validation without weakening durable manifest ownership or repair. See [foreground reply completion](../decisions/implemented/bug-fix/2026-10-09-foreground-reply-completion.md).

Native file invalidations are coalesced per segment and Workspace generation. Observation starts before the baseline capture and compares the root's original baseline with the latest observed bytes. Live publication waits for every prior Workspace to initialize and retains invalidations received during that wait. Live summaries carry totals and an opaque revision through sequenced `message.updated`, without streaming file bodies. Failed refresh retains the previous consistent revision and requests complete calibration on the next invalidation. An unresolved historical comparison preserves the accepted totals, revision and observation time with incomplete status; absent statistics stay unknown rather than becoming zero. A successful live comparison of the same Workspace generation can replace that historical range, and later invalidations retry remaining failed ranges without a polling loop. Final capture or summary failure retains explicitly incomplete evidence for a bounded read window. Remote object Workspaces keep their checkpoint boundaries without local polling. See [consistent live turn totals](../decisions/implemented/bug-fix/2026-10-25-consistent-live-turn-totals.md).

Each cached capture revision retains its own read lease before its statistics are installed, independently of aggregate publication. Failed replacement statistics release only the candidate lease; the preceding cached revision remains readable while publication is deferred. Replacement, failed admission, segment completion and Runtime cleanup release the corresponding cache ownership.

### Historical reads and upgrades

`GET /session/{sessionID}/files/current` reads the indexed latest root and compact summary independently of the transcript window. `files/comparison` admits a bounded-lifetime comparison lease containing the complete file list. Review sends this revision to both diff and version reads, and releases it on refresh or close; expiry is explicit. Fork, export, import and transfer remove Runtime-only evidence from the copy.

`GET /session/{sessionID}/files/diff` reads one retained file comparison for an optional root message and a qualified Workspace/generation/path. It never rereads the live file. Review requests full content only when a truncated file is expanded and releases the request/renderers on close.

The central `20261003-session-turn-file-checkpoints` migration delegates to the Session owner. It preserves old operation parts, trees and displayed diffs, adds explicit legacy checkpoint records from available endpoints, and upgrades summary cursors to version 4. A legacy operation interval is marked incomplete as a turn baseline; missing endpoints are never fabricated. Recovery marks pending checkpoints interrupted without scanning current files. Fork remaps checkpoint root identity and retains both endpoints; import/export and permanent deletion use the existing snapshot ownership system.

See [workspace snapshot and restore ownership](workspace-and-files.md#snapshots-rollback-and-restore) and the [workspace net change decision](../decisions/implemented/architecture/2026-10-03-workspace-net-change-review.md).

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

Ordinary `session.input` acceptance persists an inbox item before scheduling execution. A paused session with an existing root and no active rollback receives a visible `steer` item on that root, so its first resumed model call includes the new direction. Input after rollback receives a new `task` and never reopens the retained earlier rollout. Other ordinary input receives a `task` item. User pause, resume/input admission and abandon serialize per session; resumption waits for the stopped owner to settle, persists the input, reopens the paused rollout and only then clears the latch. Input on an unpaused session does not reopen its previous cancelled rollout; a fresh task owns a new run. The pre-wake repair terminalizes a cancelled root that is no longer paused, so an unfinished tool-call reply cannot block the new task. When resuming a paused task, the queued response includes `runID` separately from `item.messageID`: steering belongs to the original run, and CLI input-status polling and cancellation use that root identity; result retrieval starts after a terminal input state, so accepted input can remain queued without a Run record. A new task instead uses its accepted message ID as the run identity. After that durable write, acceptance makes a best-effort attempt to advance the session's navigation activity so an existing session returns to the top of recent lists before asynchronous execution starts; a navigation update failure is logged without rejecting the persisted input. The response returns that durable queued item; Scope initialization and the model loop begin asynchronously through `SessionDrive`. Idle `noReply` input retains its direct materialization path because a steer item cannot create an independent root.

The loop peeks the next task without deleting it, materializes its pre-allocated message ID as a root, and commits the inbox item only after that root write succeeds. A failure before materialization therefore leaves the task available for explicit retry or restart recovery. A read taken during startup always sees either the pending inbox item, the materialized root, or both; consumers deduplicate the overlap by message ID.

A task with an invalid attachment URL or deterministic execution-configuration failure remains in the inbox with `status: "failed"` and a failure reason. Runnable-work queries and startup discovery skip it while allowing later tasks to proceed. Retry reopens its failed rollout before clearing the parked state; transient storage pressure propagates without terminalizing the queued run. Parking checks presence and updates state in one transaction so cancellation cannot resurrect the item. Failed tasks remain removable and retryable before the first root materializes, cannot be guided, and are excluded from bulk guide actions. A rootless session containing only parked tasks reports the materialization failure without fabricating an assistant transcript.

Channel routing uses these same inbox semantics rather than a provider-specific mailbox. A new external chat request or Channel task assignment uses `task`; a Task update uses a deduplicated `steer`. Agenda `session_guidance` deadlines are hidden system-origin `steer` messages in the same Task Session. Project discovery, subscription acknowledgements, and other Project-level protocol events do not deliver Session work.

For conversation ingress, Channel core completes durable acceptance before the provider releases its per-conversation lane. An idle Session is accepted by reserving its loop lease before execution starts; a busy Session is accepted by writing a deduplicated `task` item with stable provider message identity and reply correlation metadata. Temporary inbound attachments are converted to durable message parts before acceptance. Provider-local queues remain transient ordering lanes, not recovery state.

Promoting a queued user task to guide/steer changes the inbox mode instead of writing permanent guided/no-reply metadata into the message model.

On abort, steer and context items are discarded while queued task items remain for explicit later execution.

During active rollback, retained steer/context delivery stays frozen until redo or a new task invalidates that rollback. Runnable-work queries apply the same rollback boundary as draining, so frozen steer items cannot repeatedly wake an owner that has no work. Passive `noReply` materialization retains its separate admission. These checks read history metadata, not transcript bodies.

If a loop run fails while runnable inbox work remains, release still yields ownership but does not immediately request another drive cycle. The durable inbox item remains available for an explicit retry or a later delivery-triggered wake instead of entering a tight self-wake loop.

## Message Chronology Index

Message info records remain the canonical transcript and `time.created`, followed by message ID, remains the canonical chronology. `MessageV2.readInfoList()` reconstructs that complete order directly from message info for full-history consumers.

Newest-first bounded readers use the derived `session_message_order_v1` index instead of eagerly parsing every message info. The index stores one sortable marker per message plus a ready/count state record. Message creation, chronology changes, removal, and permanent session deletion maintain it under a per-session write lock. Ordinary streaming updates whose `time.created` value is unchanged do not rewrite marker state.

An indexed message that was deleted can be absent while a reader traverses its snapshot. Newest-first readers tolerate that missing-record condition; storage availability and integrity errors propagate instead of hiding unreadable evidence.

The index is not part of session export or canonical recovery state. Bounded pages trust an atomically published ready state and hydrate only selected canonical message infos. Missing or non-ready state forces an owner-local rebuild. Complete-history reads validate marker cardinality and uniqueness before using the index and rebuild inconsistencies from canonical message infos. Consumers must not derive transcript semantics from marker filenames or treat the index as an independent message source.

## Model Context Projection

`MessageV2.projectModelMessages()` projects canonical session history into provider messages and derives category hints from the same emitted branches. `PromptBudgeter.buildPlan()` may transform those messages for the selected provider; before streaming, `SessionInvoke` remaps the hints over the plan's final message array so removed content is not attributed and inserted or rewritten content follows its final role. `MessageV2.toModelMessage()` is the compatibility wrapper for callers that need only the messages.

- messages with `includeInContext = false` are skipped;
- compaction filters only the prefix covered by the committed summary's `compaction.coveredThrough` cursor; cold reads, caches and stream filtering share the same selector, while provider projection places the summary before its unprocessed tail;
- attachment model policy decides whether an attachment contributes content, summary, provider file data, or nothing;
- only a bounded number of historical images are retained;
- tool calls and results are emitted in provider-compatible order;
- duplicate terminal tool parts from older histories are collapsed by provider call ID, preferring the execution outcome over an AI SDK fallback diagnostic;
- workflow wrappers are applied ephemerally and do not rewrite stored user text.
- errored-assistant filtering, canonical terminal tool selection, attachment fallback text, and historical-image placeholders apply identically to messages and provenance.
- model recovery withdraws failed-attempt text, reasoning, and unexecuted tool proposals before another attempt, so they are absent from both transcript and context; authoritative rollout records retain the attempts and accounting, as defined in [LLM recovery](llm-loop.md#completion-abort-and-errors).

Visible history and model context can therefore differ intentionally without losing the durable record.

## Rollback, Redo, and File Restore

History rollback is an event overlay on the raw transcript.

- A rollback records the cut, dropped message IDs, affected root turns, and available patch parts.
- Effective history applies rollback and unrollback events without deleting raw messages.
- Redo is allowed only for the latest active rollback and only before new messages make it ambiguous.
- Model context, conversation summaries, session forks, and frontend history use effective history. Workspace net comparisons retain recorded checkpoints independently of conversation rollback.

Rollback does not modify project files. File restoration has a separate preview and confirmation, described in [workspace restoration](workspace-and-files.md#snapshots-rollback-and-restore). It never resends a message or rewrites the original historical Diff.

## Archive and Deletion

Archiving is the normal user-facing removal state. Archived sessions remain persisted and can be managed through session APIs and CLI operations. Permanent deletion removes session-owned records and indexes according to the storage contract.

Code that displays session lists must respect archive state and the Scope-local page index rather than scanning message directories as its primary listing path.

## Recovery

The runtime repairs interrupted state instead of assuming every process exit occurred at a clean turn boundary.

Recovery covers:

- the persisted `paused` latch, and the unfinished turns that produce it
- incomplete assistant messages
- interrupted Cortex delegations
- active BlueprintLoops and their execution/audit bindings
- Light Loop and Lattice workflow sessions
- stale note `activeLoopID` and session loop metadata

An interrupted latest reply-required root is repaired through one root-anchored, per-session serialized primitive shared by startup reconciliation, Abort, abandon, and the pre-wake guard. The primitive has two mutually exclusive modes, because "the turn stopped" and "the work is over" are different facts. By default it leaves the latest assistant message non-terminal on purpose — that message _is_ the breakpoint Continue resumes from — and settles only that turn's in-flight tool parts, so every part still `pending`, `generating`, or `running` becomes `error` with `MessageV2.INTERRUPTED_TOOL_ERROR`, which states that the call was not replayed and its side effects are unknown. With `terminalize: true`, which is what Abandon passes, it instead writes the honest terminal error: it preserves an existing structured error, fills missing terminal timing, and sets `finish: "error"`, or attaches one aborted terminal assistant when the latest reply-required root has none. A message that is already terminal has its parts settled by the whole-session sweep, because an already-terminal message can still carry a part left running by the process that died mid-call, and leaving it running renders a permanent spinner that contradicts the rollout ledger. `completed` and `error` parts are untouched, so repeating repair is idempotent; the registered `20260919-settle-orphaned-tool-parts` migration applies the same wording to historical records.

The derived `paused` status carries a `reason`, an optional human-readable `description`, and `since`. The reason is one of `aborted`, `failed`, `interrupted`, or `workflow`: a user stop, a turn that ended in error, a turn the runtime never finished, or a session whose bound workflow has no durable driver. Each is reported with its own reason rather than as one opaque state, so a client can state the actual cause. The latch itself is `session.paused` (`PausedInfo`), written only by `SessionLifecycle.pause`.

The pause latch is written only by `SessionLifecycle.pause` (`packages/harness/src/session/lifecycle.ts`), which is therefore the one place that decides whether a session may stop mid-work. Three rules make it trustworthy. First pause wins, so a later reason for the same stoppage cannot churn `since` or lose the original cause, which lets repair paths call it unconditionally. Archived sessions are skipped, because archiving already removes a session from every surface. A session the latch does not apply to is skipped by the shared `latchable` predicate: an `unattended` interaction is driven by a domain that reconciles its own work, and a session carrying `cortex` delegation is a machine session in everything but that field. The same predicate is read by `SessionLifecycle.blocksDrive`, so the writer and the drive gate cannot disagree about which sessions the latch covers. Because no status is inferred from a workflow record, no persisted record can pin a session in a state that no control can clear.

Writing the pause latch records execution state, not conversation activity. It preserves both canonical `time.updated` and navigation `lastActivityAt`, including the first pause discovered during Runtime or lazy Scope startup. The changed state still publishes through `session.updated`; `paused.since` records when the pause was recognized. Rebuilding navigation from canonical session metadata retains the same recency. Explicit Continue, Abandon and new input retain their ordinary activity updates.

Take-back has one definition in `SessionLifecycle`, because the steps and their order are the same for every caller: drain the stopping turn, decide the interrupted rollout run, then clear the latch. Draining comes first because clearing the latch while the stopping turn still holds its lease lets its next iteration observe "not paused" and continue the work the user stopped. `startNewTask` leaves the interrupted run closed, since the new task root owns a fresh run; `resume` reopens that run so the next turn appends to it. Explicit continue and steering input use `resume`; new human input and a user-owned workflow start use `startNewTask`. An explicit human prompt through `SessionInvoke` takes the session back the same way, so the turn reports its own outcome instead of aborting against the latch and replaying the previous turn's terminal error; machine and passive input keep the latch. See [the restart decision](../decisions/implemented/bug-fix/2026-10-22-release-pause-when-a-user-restarts-a-loop.md).

Startup reconciliation is `SessionInvoke.reconcilePausedSessions`, registered as the `session-pause-reconcile` startup step. It selects `pause_recovery_pending` records by storage kind, verifies unfinished-turn evidence, settles interrupted parts without terminalizing the breakpoint, and persists the pause latch without driving the Session. Message writes, unsettled tool writes and inbox admission enroll their owner in the same transaction. Successful settlement removes only the observed revision; concurrent newer writes remain pending. Normal lease release acknowledges completed work so finished Sessions do not accumulate as startup candidates. Failures remain retryable and isolated per owner. Recovery yields to human control operations, pending drive arbitration, scheduled wake/admission and active execution for that Session. It rechecks ownership after asynchronous evidence reads. Drive ownership remains visible until wake ownership takes over, so reading a newly admitted task cannot classify its pre-execution interval as a restart interruption.

The versioned `20261010-session-pause-recovery-candidates` metadata migration records deferred recovery without enrolling a startup candidate. Opening a Session's detail endpoint enrolls and reconciles that owner. Metadata discovery for navigation or workflow restoration cannot promote all unknown historical owners into startup recovery. Pending-reply discovery walks bounded message-header pages back to the latest reply-required root, respecting the existing compaction boundary and reading body parts only to verify that boundary. It does not hydrate every message body to decide whether work was interrupted. Explicit complete history and repair operations retain their full-evidence behavior.

Startup no longer discovers runnable `task` inbox items and requests work, and it never materializes inbox items. Queued work that survived a restart is visible as a paused session awaiting the user, and Continue consumes it through the ordinary drive: peek, root materialization, and commit remain the ordinary loop's responsibility.

### Abort status synchronization

When a running interactive session is stopped, `SessionAbort.abort` persists the pause before signalling the owning controller, sets the phase to `stopping`, cancels descendant Cortex work and calls the shared `SessionInvoke.repairAbortState` path to settle interrupted tool parts; the frontend presents local stopping feedback immediately while that request settles. A user stop leaves the session paused and awaiting an explicit Continue or Abandon, so the work is not restarted behind the user's back. `SessionAbort.Result` reports `outcome`, `repaired`, `paused`, and `abandoned`, so a caller can tell a real stop from a no-op on an idle session.

A resumable stop closes its execution segment as `interrupted` and keeps the rollout open. Both segment finishers read `PausedTurnAbort` from their own abort signal; deferred reconciliation cannot turn a cleared pause latch into a cancelled run. Explicit abandonment and internal cancellation retain terminal outcomes.

The same rule holds while the turn is still running. A stop that leaves the session resumable aborts the runtime with a `PausedTurnAbort` reason, and the two writers that would otherwise terminalize the interrupted turn — the processor's error flattening and its post-unwind finalization, plus the `completeAssistantWithError` funnel that can win when the abort lands during turn preparation — read that intent from the abort signal they are already unwinding, so the intent is atomic with the stop rather than a flag a concurrent repair has to race. A release carrying this pause reason cannot schedule queued work while abort repair is still pending. An internal cancellation, an abandon, and a stop on a session the latch cannot hold carry no such reason and still settle the turn honestly.

`repairAbortState` republishes the resolved status through `SessionManager.publishStatusOnly()`, so a latch change reaches live clients. The published status is exactly what `SessionWorking.resolve()` resolves — `paused` with its reason for a latched session, otherwise `busy`, `retry`, or `idle` — instead of an unconditional idle. `internalCancel` is the single opt-out from latching: a cancellation a domain performs on work it owns (Lattice, Light Loop, Cortex, Boss) settles the turn without writing a pause the user never requested. `terminalize` and `abandonWorkflow` are what Abandon passes so the transcript gets an honest end and the bound workflow is cancelled. Abandon fences and removes all previously queued inbox work, waits for its live execution owner to exit, cancels the removed tasks' rollout records, terminalizes the breakpoint, and invokes the bound workflow's domain cancellation. Cancellation hooks also complete before the pause is cleared. Later input survives the fence. Only successful settlement clears the pause and returns `paused: false`; a failed cancellation returns `SessionAbandonError` (HTTP 409) and remains paused for explicit retry. The `paused` result always reports the persisted state, including a pre-existing pause.

This separation exists because `SessionEvent.Idle` has side-effect consumers — `ContinuationKernel` for automatic loop wakeups — that must not fire for repair-only status corrections. Lifecycle idle (`SessionEvent.Idle`) remains owned exclusively by `SessionManager.release()`, which publishes both `SessionEvent.Status` and `SessionEvent.Idle` when the runtime loop voluntarily yields ownership. Completion notifications are driven by the independent `SessionEvent.Completion` event emitted after each root task produces a terminal reply; they do not depend on `SessionEvent.Idle`.

## Invariants

- A session belongs to one Scope and has one explicit workspace binding or `null`.
- At most one active loop lease owns a session, including while it is starting or stopping.
- Agent workers never own Session/Message persistence or canonical event sequencing.
- Internal execution phases refine an owned loop without replacing the public busy/retry/idle status contract.
- One root user message owns each task and all assistant messages in that task.
- Root thinking metadata remains historical; each request captures the saved session model selection before preparation. Steer and context messages never carry a thinking choice.
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

### Tool execution evidence

The Control Plane tool resolver records execution intent inside its existing call-ID deduplication boundary. `Tool.define()` captures the original result before automatic truncation, and the MCP path captures structured content before presentation hooks. The tool record retains the original result and returned observation independently of the session preview. Recording failures close run admission and signal cancellation instead of authorizing another tool attempt.

Local Bash opens process evidence before spawning. stdout and stderr are archived before the process registry's bounded display buffer. Each binary frame contains a channel byte (1 for stdout, 2 for stderr), a four-byte big-endian payload length, and up to 64 KiB of payload. Frame order follows observation order at the host. The reader pauses each channel until its archival write is acknowledged, bounding queued data; child-close grace does not expire while that recorder owns backpressure. Normal close commits the stream before the foreground tool completes. Interrupted drainage retains partial evidence. An intentionally backgrounded process keeps its independent process record after its launching tool returns; its live stream is not complete evidence at that earlier boundary.

Continuation admission and rollout reconciliation share a per-session, per-root lock. Admission holds it while draining steer items, materializing their messages, deciding whether a model call is needed, and opening an execution segment. Reconciliation waits while admission holds the lock and requires the latest input for the root to have a terminal reply; an earlier reply does not settle a later continuation.

When the latest root has an unanswered input after a terminal reply, admission can continue its completed Rollout through `RolloutLedger.continueRun` before opening another segment. The run retains its original input, configuration and completed evidence; its aggregate completion fields clear and recording becomes partial until the continuation settles. Automatic continuation cannot reopen cancelled or failed runs, clear cancellation requests, or bypass recording failures. Explicit Continue uses the same admission for an already materialized unanswered notification, committing its recovery receipt and pause release with the run transition. Completed work without unanswered input stays closed. See [completed-root continuation](../decisions/implemented/bug-fix/2026-10-26-continue-completed-roots-for-steering.md).

Rollout reconciliation resolves terminal replies from effective transcript history with rollback events applied. The compacted model working set cannot own historical execution outcomes because its projection excludes roots and replies before the compaction boundary.

Run cancellation drains its execution owner, detached jobs, and native processes before taking the settlement lock. With no active segment, it terminalizes orphaned call/tool/process records as interrupted before recording cancellation, so post-release reconciliation cannot race the cancellation result. Active segments still block closure.

The continuation repair migration persists a rollout recovery intent before reopening incorrectly completed work. Startup routes that intent through the normal drive/wake path even when the inbox is empty. The intent survives failed wake attempts and is cleared once the root is answered, cancelled, failed, or superseded. This targeted repair does not enable automatic resume for ordinary interrupted sessions or add messages to the transcript.

Recording-error cancellation carries the source root ID. The active loop lease binds its current root before model or tool work; an error from an older root cannot cancel a replacement root, including another root processed under the same lease. An unbound starting lease is not ownership evidence for an old task. Explicit user cancellation retains its session-wide semantics.

Workspace-free sessions can use enabled model, network and managed-data capabilities. Input acceptance and the model loop do not require a physical Workspace. Workspace-dependent operations validate the persisted binding and acquire resource ownership when used, regardless of control profile. An unavailable file binding does not block managed-data or network tools. Missing projects retain readable history and never acquire the host working directory implicitly. See [Runtime and Scope](runtime-and-scope.md#session-workspace).

The version-3 summary cursor preserves individual operation identities and endpoints. Its owning migration upgrades version-2 ranges without changing canonical history, metadata or archived state; obsolete derived cursors rebuild from canonical parts. Snapshot retention and transfer include both endpoints. Review keeps repeated changes to the same path independently expandable, while the compact turn summary groups their file counts and preserves Workspace identity.

## Presentation and full-history operations

`SessionHistory.turnInfos({ sessionID, rootID, signal })` reads ordered message metadata for one effective root, including its root message. `turnMessages()` uses the same selection before materializing those bodies. Both honor deletion, rollback and cancellation; metadata-only consumers must not call full-history `Session.messages()`. The result is local to one operation and does not cache delivery flags.

SessionHistory owns the ordered display projection used by `session.timelinePage`, `session.partPage`, `session.displayManifest`, `session.partContent` and `session.messageDetails`. Header and Part summaries carry separate original-content versions and byte counts; Part summaries are never canonical Parts. Headers retain compact file-change metadata while original prompts, patches and larger metadata resolve on demand. Canonical message writes and removals update the display index in the same transaction. Versioned migrations either publish changed headers and Parts through those hooks or invalidate the affected Part page and text-search generation in the same storage transaction; a previously prepared cache cannot outlive a migrated canonical record. Manifest reads prepare owner migrations before opening their snapshot. Owner repairs of existing Part summaries use the same projection writer to advance the parts generation, even when the message header is unchanged. Historical header and Part preparation resumes from persisted cursors and verifies source generation before publishing readiness. Every display read applies the same effective rollback visibility used by canonical history.

Text search indexes canonical Part versions incrementally, excluding system text through `MessageV2.isSystemPart()`. SQLite uses FTS5 trigram indexing for longer substrings, while short queries and PostgreSQL use bounded continuation pages. Results are checked against source revision and effective message visibility. Changed and removed sources enqueue bounded collection of obsolete fragments. Original copying and export cover the complete effective history independently of display and body caches.

Execution facts are internal fixed-size fields on stored Part summaries, with independent version, readiness and resumable per-message cursors. Only explicit execution-summary demand prepares old facts. Preparation captures canonical revisions and Part membership generations, reads exact normalized prefixes outside SQL transactions, and validates before publishing each batch. Current message headers supply root, completion, error and accounting semantics. Public Part pages omit the internal fields. Ordinary timeline preparation, send and startup do not trigger execution backfill, and unchanged-source read failures remain visible errors.

Conversation text operations read canonical effective history in one read snapshot, preserving rollback visibility and original Part text across concurrent writes. Their default extraction retains the assistant reasoning fallback when no text Part exists, omits synthetic text and exposes reasoning/tool inclusion explicitly. Portable transcript archives retain raw history and evidence for import. Inbox admission atomically commits its item and navigation activity before publishing notifications; cancellation can observe the accepted item before a Run exists. Passive materialization has an explicit transient owner purpose: overlapping idle `noReply` inputs retain passive recovery admission, and passive-only work cannot request an LLM loop or clear a pause.

Media generation presentation keeps a stable invocation identity through terminal settlement. Tool error `reason: "cancelled"` records an owning invocation AbortError; timeouts and ordinary tool failures do not acquire that reason. This does not establish user intent or terminalize a paused session. Cancelled media remains in canonical history but contributes no display row, placeholder or replacement status. Bounded summaries and hydrated timelines share that policy; a Session migration invalidates older derived display indexes. Renderers retain genuine failures and show completed files through the shared attachment gallery.

## Manual Host migration

Paused interactive roots can move to a chosen connected Host through [Session transfer](session-transfer.md). Migration preserves the pause latch and retained execution evidence. Source execution remains gated after committed cutover, and target execution requires an explicit Continue.
