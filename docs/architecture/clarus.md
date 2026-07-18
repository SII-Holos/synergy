# Clarus

Clarus is a native Holos Agent Tunnel capability that lets Synergy manage projects, task assignments, and project activity through the existing authenticated Holos WebSocket connection. There is no standalone Clarus daemon, adapter process, or second transport; all `clarus.*` operations and events travel through the one Agent Tunnel opened during Holos authentication.

## Transport

Clarus uses the native Agent Tunnel transport defined in `packages/synergy/src/holos/native.ts`. The authenticated tunnel provides:

- `NativeMessage` — wire envelope with trusted `agentID`, typed `type` string, opaque `payload`, `requestID`, `generation`, and `epoch`.
- `NativeTunnelPort` — outbound request dispatch (`sendNativeRequest`) plus observer registration for inbound native messages and connection state changes.
- Size and depth bounds at the tunnel boundary: 1 MB raw frame limit, 64 KB string fields, 256 B ID fields, 16-level object depth, 200 array entries, 200 object keys, 256 KB payload budget.

The `createClarusAgentTunnelAdapter` factory in `packages/synergy/src/holos/clarus.ts` wraps the generic `NativeTunnelPort` into the typed `ClarusAgentTunnelPort` contract, producing strict camelCase DTOs for consumers.

## Connection Lifecycle

The internal Holos connection has states `disabled`, `connected`, `connecting`, `disconnected`, `reconnecting`, and `blocked`. Clarus maps these to five public navigation connection statuses:

| Internal       | Public             |
| -------------- | ------------------ |
| `disabled`     | `disabled`         |
| `connected`    | `connected`        |
| `connecting`   | `reconnecting`     |
| `reconnecting` | `reconnecting`     |
| `disconnected` | `sign_in_required` |
| `blocked`      | `sync_failed`      |

The public status is consumed by the Clarus navigation panel, which shows one of the five statuses and renders appropriate UI for each.

## Outbound Operations

The Agent Tunnel supports five typed Clarus outbound operations dispatched through the tunnel:

| Operation            | Wire type                     | Response type                         |
| -------------------- | ----------------------------- | ------------------------------------- |
| `subscribeProject`   | `clarus.project.subscribe`    | `clarus.project.subscribed`           |
| `unsubscribeProject` | `clarus.project.unsubscribe`  | `clarus.project.unsubscribed`         |
| `sendProjectMessage` | `clarus.project.message.send` | `clarus.project.message.created`      |
| `extendTask`         | `clarus.runtime.task.extend`  | `clarus.runtime.task.extended`        |
| `recordTaskResult`   | `clarus.runtime.task.result`  | `clarus.runtime.task.result.recorded` |

Every request carries a caller-chosen `requestID`, optional `timeoutMs`, and optional `AbortSignal`. The response is correlated to the request:

- A matched response DTO with the expected `responseType` resolves the promise.
- A `not_dispatched` failure means the request never left the local process. The failed outbox record remains immutable for audit, while a task-result binding returns to `running` and may be submitted again with a new `requestID` after the local transport recovers.
- A `rejected` failure means the Holos gateway definitively rejected the request with a known `code` and message. The task result moves to `needs_attention` and is not retryable without a new Clarus assignment.
- An `ambiguous` failure means the request may or may not have been processed: `timeout`, `aborted_after_dispatch`, `disconnected`, `invalid_response`, or `unexpected_response`. The task result moves to `needs_attention` and must not be retried automatically.

Clarus adopts **Scheme A** for ambiguous outcomes: an ambiguous request may have already succeeded remotely, so callers inspect persisted state and wait for external confirmation or reassignment. Only `not_dispatched` task-result outcomes are retry-safe, and each retry creates a new outbox record instead of rewriting the prior attempt.

## Inbound Events

The tunnel dispatches nine known `clarus.*` event types to registered observers:

| Wire type                             | Semantic DTO                |
| ------------------------------------- | --------------------------- |
| `clarus.project.subscribed`           | `projectSubscribed`         |
| `clarus.project.unsubscribed`         | `projectUnsubscribed`       |
| `clarus.project.message.created`      | `projectMessageCreated`     |
| `clarus.runtime.task.assigned`        | `runtimeTaskAssigned`       |
| `clarus.runtime.task.extended`        | `runtimeTaskExtended`       |
| `clarus.runtime.task.result.recorded` | `runtimeTaskResultRecorded` |
| `clarus.project.file.uploaded`        | `projectFileUploaded`       |
| `clarus.project.system.event`         | `projectSystemEvent`        |
| `clarus.notary.record.created`        | `notaryRecordCreated`       |

Each known event is parsed against a strict Zod schema, converted to a bounded camelCase DTO with size-limited string fields and depth-constrained objects, and re-serialized for a final 256 KB budget check. Payloads exceeding the budget are silently dropped.

Unknown event types produce `kind: "unknown"` observations. Parse failures produce `kind: "invalid"` observations with issue paths and messages. Both variants are delivered to observers so consumers can decide whether to surface the anomaly.

Every `clarus.*` wire frame also passes through the Envelope parser (native type fallthrough path in `packages/synergy/src/holos/envelope.ts`), which treats any non-envelope type as a native operation without needing per-event routing.

## Persistence Model

### Project Bindings

Persisted at `StoragePath.clarusProjectBindingRoot()`, project bindings store:

- `agentId`, `projectId` — primary composite identity
- `lifecycle` — `active | archived | exited | revoked | deleted`; drives subscription management
  `membership` — optional; describes the agent's membership role
- `desiredSubscription` — whether the project should be subscribed
- `projectName`, `projectSlug`, `projectStatus`, `primaryAgent` — cached metadata
- `messageCursor`, `lastProjectActivityAt` — reconciliation state
- `lastReconciliationAt`, `lastReconciliationError` — reconciliation health

Bindings are V3 schema (Zod-serialized) and stored under sharded paths keyed by encoded `agentId:projectId` segments. The migration `20260715-clarus-binding-sharding` moved bindings from flat legacy storage to canonical sharded paths.

### Task Bindings

Persisted under the same sharded agent/project scope, task bindings (V4 schema) store:

- `agentId`, `projectId`, `taskId` — primary identity
- `sessionID`, `workspacePath`, `owningScopeID` — home-Scope session binding
- `title`, `status` (waiting|running|needs_attention|submitting|submitted|failed|expired|cancelled), `resultState` (idle|prepared|dispatched|acknowledged|not_dispatched|ambiguous|rejected|local_only), `phase`, `attempt` — Blueprint task state
- `contextHydration`, `localContinuationEnabledAt`, `resultRecordedAt` — lifecycle timestamps
- `assignmentState`, `assignmentInboxItemID` — assignment delivery and recovery
- `taskSessionOwnershipClaim` — crash-recovery ownership marker

The migration `20260715-clarus-v4-forward` upgraded task bindings from V3 to V4.

### Activity Timeline Index

Project activity records (project messages with content, metadata, and file references) are stored under `StoragePath.clarusProjectActivityRoot()`. Each record is indexed by the composite agent/project/message identity and by a chronological sort key. Paginated reads use bounded scan, ghost cleanup, and orphan-index repair budgets. Cursors advance over the inspected sort-key window so corrupt entries cannot stall progress. The migration `20260715-clarus-activity-timeline-index` built the index.

### Outbox

The Clarus V2 outbox stores every outbound operation before tunnel dispatch. Its terminal states are `acknowledged`, `not_dispatched`, `rejected`, `ambiguous`, and `local_only`; terminal records accept only exact idempotent replay. A retry after `not_dispatched` allocates a new request ID so the original failed attempt remains auditable.

### Dedup and Fanout Progress

Project-level message deduplication uses a per-message record under the agent/project scope. Per-target fanout progress tracks which task-binding sessions have received a project message, preventing double-delivery after crash recovery.

## Reconciliation

The runtime periodically reconciles each actively subscribed project's messages from the Clarus REST API. Discovery and message backfill are bounded by page and aggregate cycle budgets. A discovery sweep that stops at a pagination cap or non-progressing cursor records a reconciliation error and does not archive unseen projects. Subscription failures preserve their structured remote message in reconciliation state.

Message cursors advance only after every assignment in the page is safely handled. If payload hydration or assignment ingestion fails, the project is marked deferred and keeps its previous cursor, while rotation allows other projects to continue making progress. The reconciliation record remains unhealthy until a complete cycle succeeds.

## Session Integration

### Task Sessions

When a `runtimeTaskAssigned` event arrives, or when the user continues a task locally, the runtime calls `getOrCreateTaskSession` in `packages/synergy/src/clarus/session-router.ts`. This:

1. Checks for an existing session matching the Clarus task endpoint (`kind: "clarus"`, `role: "task"`).
2. Checks for an existing task binding with a discoverable session.
3. Checks for crash-recovery ownership claims.
4. If no session exists, creates one under the **Home Scope** with a dedicated Clarus workspace directory, records the binding, and acquires/resolves ownership.

All Clarus task sessions use the Home Scope regardless of which project Scope is currently active. They carry a `SessionEndpoint` with `kind: "clarus"` and `role: "task"`, not a directory-based endpoint.

Live and backfilled assignment events preserve `attempt_mode` and `retry_of_task_id` from the Clarus wire contract in the task input, so retry lineage reaches the task session without changing the composite binding identity.

### Project Message Delivery

When a `projectMessageCreated` event arrives, the session router delivers the message to all non-terminal task bindings within the project. Delivery uses the persistent session inbox with `source: { type: "clarus" }`. Project messages use deterministic inbox item and message IDs derived via SHA-256 from the composite identity to prevent duplicate delivery across process restarts.

### Workspace

Each Clarus task session receives a dedicated directory under the Synergy configuration root, managed by `ClarusWorkspace.ensureWorkspace`. The workspace binds as `type: "clarus_project"` on the session.

The public `/global/clarus/navigation` endpoint produces a single snapshot containing:

- `connection` — public connection status (`disabled | connected | reconnecting | sign_in_required | sync_failed`), agent ID, and optional error.
- `projects` — project bindings with strict allowlist DTO fields including `agentId`.
- `tasks` — task bindings with strict allowlist DTO fields including `agentId`, `status`, `resultState`, `localContinuationEnabledAt`, and `resultRecordedAt`.

Navigation identity is composite end to end. The frontend keys projects by encoded `(agentId, projectId)` and tasks by encoded `(agentId, projectId, taskId)`, so IDs that collide across agents cannot overwrite grouping or selection state. Active projects remain visible even with no tasks; inactive projects appear in the History group only when durable task bindings remain. Navigation reads are bounded to at most 16 agents, 500 projects, 5 project pages, and 3 task pages.

### Task Priority

Tasks are sorted by status priority:

| Priority | Status            |
| -------- | ----------------- |
| 1        | `needs_attention` |
| 2        | `running`         |
| 3        | `submitting`      |
| 4        | `waiting`         |
| 5        | `submitted`       |
| 6        | `failed`          |
| 7        | `expired`         |
| 8        | `cancelled`       |

Within the same priority band, tasks are ordered by most recent `updatedAt` first. Terminal statuses (`submitted`, `failed`, `expired`, `cancelled`) are not eligible for project message fanout.

`GET /global/clarus/projects/{projectId}/tasks/{taskId}` returns a bounded task detail DTO with the session binding needed for navigation; internal workspace and Scope paths are excluded.

`POST /global/clarus/projects/{projectId}/tasks/{taskId}/continue-local` enables local continuation of a `submitted`+`acknowledged` task. Possible responses:

- `200` — full updated navigation task DTO returned (resultState → local_only).
- `400 CLARUS_CONTINUE_LOCAL_INELIGIBLE` — task not in `submitted`/`acknowledged` state.

Already-local-only tasks return the existing binding (idempotent). `not_dispatched` results remain running and accept a new submission with a fresh request ID; `ambiguous` and `rejected` results are terminal read-only and never auto-retried.

### Composer

`POST /global/clarus/composer/submit` sends a message to a project through the Agent Tunnel. Input includes `projectId`, `agentId`, `userId`, `content` (1 B – 1 MB), optional `messageType` and `fileRefs` (max 50). The backend calls `sendProjectMessage` through the Agent Tunnel and returns the message ID and tunnel metadata.

`GET /global/clarus/composer/users` searches for Clarus users by name or agent ID, capped at 5 candidates.

`GET /global/clarus/composer/projects` searches for Clarus projects by name, capped at 5 candidates.

## Frontend

### Navigation

Clarus registers as a sidebar navigation entry immediately after Home and before Agenda, with semantic icon token `clarus.main` and path `/clarus`.

The navigation surfaces render:

- A **connection status bar** showing the five public states and the stored synchronization error for `sync_failed`.
- **Active projects** with their tasks sorted by priority, including empty projects with a `No tasks yet` state.
- A **History** group containing only inactive projects with durable task records.
- Task rows that include non-idle result state in the status label and open the native Clarus Task Session in the standard session page.

Project and task selection uses composite keys that include `agentId`. Sidebar disclosure controls are keyboard-operable with Enter and Space. Clarus task sessions use the standard session prompt surface; Clarus-specific completion controls do not gate or replace normal session navigation, and the Agent submits through `clarus_submit_task_result`.

### Event-Driven Invalidation

The frontend subscribes to `clarus.navigation.updated` bus events and Holos reconnect-version changes. Both triggers call `invalidateAndRefresh` with version-guarded coalescing (at most one in-flight request plus one trailing), preserving the last-good navigation snapshot on error.

The frontend uses the generated SDK (`createSynergyClient`) for all API calls. There is no raw fetch, no second WebSocket, and no polling loop.

All routes are registered under the `/global/clarus` prefix:

| Method | Path                                                                | Purpose                    |
| ------ | ------------------------------------------------------------------- | -------------------------- |
| GET    | `/global/clarus/status`                                             | Connection status          |
| POST   | `/global/clarus/reconnect`                                          | Reconnect tunnel           |
| GET    | `/global/clarus/navigation`                                         | Navigation snapshot        |
| GET    | `/global/clarus/projects`                                           | List project bindings      |
| POST   | `/global/clarus/projects`                                           | Create project binding     |
| GET    | `/global/clarus/projects/{projectId}`                               | Get project binding        |
| PUT    | `/global/clarus/projects/{projectId}`                               | Update project binding     |
| POST   | `/global/clarus/projects/{projectId}/deactivate`                    | Deactivate project binding |
| GET    | `/global/clarus/projects/{projectId}/activity`                      | Project activity timeline  |
| GET    | `/global/clarus/tasks?projectId={projectId}`                        | List task bindings         |
| GET    | `/global/clarus/projects/{projectId}/tasks/{taskId}`                | Task detail                |
| POST   | `/global/clarus/projects/{projectId}/tasks/{taskId}/continue-local` | Continue task locally      |
| GET    | `/global/clarus/composer/users`                                     | Search Clarus users        |
| GET    | `/global/clarus/composer/projects`                                  | Search Clarus projects     |
| POST   | `/global/clarus/composer/submit`                                    | Submit composer message    |

All routes use bounded Zod schemas with strict allowlist fields, limit validation, and redacted error messages. OpenAPI metadata is applied through `hono-openapi` so the generated SDK reflects each schema and ref.

## Ownership

| Area                   | Primary implementation                                              |
| ---------------------- | ------------------------------------------------------------------- |
| Tunnel adapter         | `packages/synergy/src/holos/clarus.ts`                              |
| Agent tunnel port      | `packages/synergy/src/clarus/agent-tunnel-port.ts`                  |
| Session router         | `packages/synergy/src/clarus/session-router.ts`                     |
| Binding persistence    | `packages/synergy/src/clarus/binding.ts`                            |
| Schemas and migration  | `packages/synergy/src/clarus/schemas.ts`, `clarus/migration.ts`     |
| Navigation DTOs        | `packages/synergy/src/clarus/navigation.ts`                         |
| Runtime / producer     | `packages/synergy/src/clarus/runtime.ts`                            |
| Agent result tool      | `packages/synergy/src/tool/clarus-submit-task-result.ts`            |
| REST port              | `packages/synergy/src/clarus/rest-port.ts`, `clarus/rest-client.ts` |
| Events                 | `packages/synergy/src/clarus/event.ts`                              |
| Server routes          | `packages/synergy/src/server/clarus-route.ts`                       |
| Frontend model         | `packages/app/src/context/clarus/clarus-model.ts`                   |
| Frontend components    | `packages/app/src/components/clarus/`                               |
| Frontend session links | `packages/app/src/composables/session-navigator.ts`                 |
| Generated SDK          | `packages/sdk/js/src/gen/` (types, client operations)               |

## Cross-Cutting Invariants

- A Clarus assignment creates an autonomous, unattended task session whose Agent loads `clarus-agent-participation` and explicitly submits success or failure through `clarus_submit_task_result`; Session Idle/Error never auto-submits a result.
- Clarus task sessions use native `SessionNav.category = "clarus"` with project/task metadata and appear only in the dedicated Clarus navigation area.
- Session navigation indexes are rebuildable V2 caches; reading a legacy V1 index rebuilds it from authoritative Session endpoint data so existing Clarus sessions self-heal into the native `clarus` category.
- There is exactly one Holos Agent Tunnel WebSocket. Clarus is a native capability on that transport; there is no separate Clarus daemon, adapter process, polling loop, or second WebSocket.
- Every `clarus.*` wire frame enters through `packages/synergy/src/holos/envelope.ts` native fallthrough and reaches `createClarusAgentTunnelAdapter` for bounded DTO conversion.
- Clarus request outcomes have three transport semantics: `not_dispatched` is locally retry-safe with a new request ID, `rejected` is a definitive remote refusal, and `ambiguous` follows Scheme A with no automatic retry.
- Project and task bindings are stored under sharded paths using URL-encoded agent ID and project ID segments validated to 512 characters max.
- Live and backfilled assignment ingestion preserves retry lineage (`attempt_mode`, `retry_of_task_id`) in the task input.
- Task sessions always use the Home Scope; they are never bound to a project-directory Scope.
- The frontend refreshes through the generated SDK and single `clarus.navigation.updated` event, plus reconnect-version invalidation. No raw fetch, no poll, no second socket.
- Navigation DTOs use strict Zod allowlists, and frontend identity is composite across agent, project, and task IDs.
- Continue-local requires `submitted` + `acknowledged`; `ambiguous` and `rejected` are terminal read-only, while `not_dispatched` remains retryable.
