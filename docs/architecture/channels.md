# Channels

## Ownership

The Channel domain adapts external accounts into Synergy-owned Scope and Session behavior. Providers own remote protocol details; Channel core owns target identity, account lifecycle, managed Project ownership, task routing, diagnostics, and integration with the durable Session inbox.

Providers report typed ingress facts through `ChannelHost` and may support one or both ingress families:

- Conversation ingress translates remote messages into endpoint Sessions through `host.conversations.receive()`. Matching provider capabilities may supply replies, proactive pushes, media, reactions, and streaming.
- Project and Task ingress reports discovery and assignments through `host.projects` and `host.tasks`. Project discovery does not create a conversation Session; Task assignments use dedicated Task Sessions.

Ingress families are capabilities, not mutually exclusive provider kinds. A provider may support both. Feishu currently exposes conversation ingress with a `self_connected` lifecycle. Clarus exposes only Project and Task ingress with a `borrowed_transport` lifecycle over the existing Holos Agent Tunnel. GitHub exposes conversation ingress with a `self_connected` lifecycle: it polls the GitHub REST API outbound (no inbound webhook), synthesizes repository events (`issue.opened`, `pull_request.opened`, `pull_request.synchronize`, `comment.created`), and delivers them through `host.conversations.receive()` with `chatId = "owner/repo#<number>"`. Comments only wake an agent on an explicit mention of the bot handle (the GitHub App slug by default), and each issue/PR thread resolves to its own random-hash checkout directory Scope via the provider's `resolveConversationScope()` hook. See [GitHub Channel](github-channel.md).

## Target Identity

`ChannelTarget` is the canonical typed identity for new Channel endpoints:

```ts
type ChannelTarget =
  | { kind: "chat"; chatId: string }
  | { kind: "project"; externalProjectId: string }
  | {
      kind: "task"
      externalProjectId: string
      externalTaskId: string
    }
```

Project targets identify managed ownership and navigation. Project discovery does not materialize them as conversation Sessions.

Target keys include provider type and account ID. Project and Task identities therefore cannot collide with chat identities or with another account's external IDs.

Existing Feishu endpoint records retain the legacy `chatId` / `scopeKey` encoding. `Channel.Info` accepts exactly one identity form: the legacy chat fields or a typed target. This preserves existing Feishu keys while preventing new callers from mixing the two contracts.

Feishu derives an endpoint `scopeKey` from the account's `groupSessionScope`. Topic and sender modes encode the topic or sender into the key; `group_thread` uses the Feishu `thread_id` as the only continuity key and falls back to the inbound `message_id` when no thread exists. A durable `channel/feishu/thread_bindings` record maps a returned `thread_id` back to the `scopeKey`, so later messages in the same thread reuse the same session and the first reply is sent with `reply_in_thread: true`.

## Provider and Transport Lifecycle

Every provider declares one lifecycle:

- `self_connected` providers own their transport and use Channel's bounded exponential reconnect loop.
- `borrowed_transport` providers observe a transport owned by another runtime and never install a second reconnect loop. When such a provider exposes `waitForTransport`, Channel reports `waiting_for_transport`, waits on the owner's readiness signal without polling, and calls `connect` once for each ready generation. Each pending or connected attempt owns a distinct abort generation; transport replacement invalidates that generation before Channel waits for the next owner-provided transport, so an old initial sync cannot publish connected or failed state over its successor.
  Provider initialization failures after readiness may retry through Channel's bounded backoff without creating or reconnecting the borrowed transport.

Clarus borrows the one authenticated Holos Agent Tunnel WebSocket through `HolosRuntime.getNativeTunnel()`. Clarus operations and events use their `clarus.*` operation name as the top-level wire `type`; they are not wrapped in a second `native` envelope. Agent identity, tunnel epoch, and monotonic connection generation are attached from the current local Holos provider after receipt rather than trusted from frame metadata. The port owns request validation, correlation, observer isolation and cleanup, and transport disposition:

- `not_dispatched` means bytes were not sent and an explicit retry may be safe.
- `rejected` is an authoritative terminal rejection, including a correlated gateway error.
- `ambiguous` means dispatch may have occurred; automatic retry is forbidden.

Disconnect or a missed-pong deadline settles in-flight native requests as ambiguous and notifies borrowed consumers. The Holos owner checks the deadline inside its existing heartbeat interval rather than adding another timer. Clarus removes its observers and returns to passive transport waiting; Channel does not create another WebSocket, timer, polling loop, or transport reconnect loop.

## Managed Project Ownership

A provider using Project and Task ingress maps each `(channelType, accountId, externalProjectId)` identity to one real Project Scope through `ManagedProjectOwnership`.

The owner:

1. hashes the complete external identity;
2. creates a deterministic workspace under `data/channel/workspaces/<identity-hash>/workspace`;
3. rejects path escape, non-directory components, and symbolic links;
4. keeps that workspace as an ordinary non-Git directory without inheriting an ancestor `.git`;
5. resolves the workspace into a normal Project Scope with directory-based identity;
6. writes both a forward ownership record and a reverse Scope index.

Ownership records retain only Channel identity, Scope ID, deterministic directory, remote state, and timestamps. Providers do not store a second Scope model and do not directly create or move Sessions.

Remote state is `active`, `paused`, `stale`, or `archived`:

- discovery refreshes `active` / `paused` ownership and `lastSeenAt`;
- a complete discovery snapshot marks absent Projects `archived`;
- a partial or failed refresh never performs negative reconciliation;
- transport loss may mark owned Projects `stale` without deleting local state;
- remote archive preserves the Scope, files, Sessions, and ownership record.

Local archive requests are rejected while remote state is `active` or `paused`, including archive attempts through the Scope update route. After ownership becomes `stale` or `archived`, ordinary local archive behavior is allowed.

Managed Project Scopes are projected in navigation under their Channel account and excluded from the generic Projects section. This projection is derived from canonical Scope navigation metadata; the frontend does not maintain a Clarus-specific Project store.

## ChannelHost Boundary

Providers receive an account-bound `ChannelHost` rather than direct Scope or Session constructors.

Conversation ingress separates durable acceptance from execution. `host.conversations.receive()` returns an acceptance result whose `execution` Promise owns streaming and generation. A provider lane waits only until Channel core has resolved the endpoint Session and either reserved its loop lease or durably written the request to `SessionInbox`; it tracks accepted execution separately for bounded account drain. Feishu serializes this acceptance by its existing conversation key, preserving same-topic order and different-topic parallelism without creating a provider-owned durable queue.

`host.projects` owns:

- idempotent ensure of active or paused managed Projects;
- complete versus partial reconciliation;
- stale and archived transitions.

`host.tasks.dispatch` owns Task Session creation and delivery:

- it requires active owned Project state;
- it resolves the managed Project Scope;
- it keys one endpoint Session by provider, account, external Project, and external Task;
- when provider state already binds the Task to a Session, it validates and reuses that bound Session under the endpoint creation lock, so concurrent replay cannot create a replacement;
- it runs provider preparation before Session creation or inbox delivery, so a failed precondition leaves no empty Task Session;
- it creates that Session with `autonomous` control and unattended interaction;
- it delivers the assignment as a visible `task` inbox item;
- it may deliver separate hidden system-origin participation guidance as a deduplicated `steer` item;
- it persists provider assignment state before waking the Session loop.

Exact assignment replay reuses the Session and delivery key. Clarus assignment delivery identity includes account, Project, Task, run, subtask, and attempt: a new run, subtask, or attempt for the same external Task creates a new delivery in the same Task Session, while an exact replay remains deduplicated. A new attempt resets result and extension state so a previously completed assignment becomes running again. A retry represented by a new external Task ID creates a new Session and retains retry lineage.

`host.tasks.update` sends a deduplicated visible `steer` item only when the owned Project and Task Session still exist. Archived remote Projects never receive dispatch or update delivery.

## Native Clarus Task Flow

Clarus account configuration lives in the Channel domain and uses the active Holos agent credentials. Holos login provisions a disabled matching account, and the Holos migration runner backfills that account for existing active identities. The configured account ID must equal the active Holos agent ID. Server startup registers and starts Channels before it initializes Holos, allowing borrowed providers to install their transport observers first; while the Agent Tunnel is still connecting or reconnecting, the Clarus account remains in `waiting_for_transport` until the matching authenticated transport becomes ready.

On connect or manual refresh, Clarus:

1. lists all visible Projects through the Clarus REST API;
2. reconciles the complete snapshot into managed Project ownership;
3. subscribes to each active Project and waits for its correlated subscription acknowledgement;
4. recovers eligible result and extension outbox records.

`clarus.project.membership.accepted` is a refresh hint, not an ownership grant. Its full membership DTO is validated at the tunnel boundary, including nullable invitation/acceptance timestamps and the platform's numeric inviter identity. On receipt, the provider repeats the authoritative active/paused Project sync and correlated active-Project subscriptions. REST reconciliation establishes managed ownership from the authoritative Project snapshot; the subscribed acknowledgement establishes remote readiness. The provider never accepts an invitation or creates ownership from the event payload alone.

The provider accepts membership refresh hints, subscription state, and runtime Task events. Assignment payloads normalize nullable retry lineage and attempt mode to absent semantic fields instead of rejecting the event. Legacy Project message, file, system, and notary events are not Channel behaviors and are classified as unknown by the Clarus adapter.

`clarus.runtime.task.assigned` rejects an already-expired deadline before REST preflight, Session creation, assignment persistence, inbox delivery, or model wake, then records a bounded informational diagnostic. A previously bound assignment whose owning Session is archived is blocked under the Session endpoint lock, retains its original binding, creates no replacement Session, and records a bounded warning diagnostic.

If an assignment arrives before managed ownership exists, `ChannelHost` still raises `ChannelHostProjectNotOwnedError`. Clarus performs one bounded authoritative Project sync and retries the same dispatch once. If ownership remains absent, it records a structured error and preserves the failure; it never treats the assignment's `project_id` as authorization, and archived ownership remains unavailable.

Eligible assignments resolve declared `input_refs` before dispatch. The provider uses the version-locked Holos CLI as a REST companion to read runtime context and phase state, map artifact names to inline bodies or file references, and preview or download files into the managed Project workspace. Hydration is bounded, path-safe, cached per run, and fail-closed: unresolved declared inputs prevent Session creation, assignment persistence, inbox delivery, and model wake. Assignments without `input_refs` do not run this REST preflight.

After successful preparation, Clarus dispatches the Task Session through `ChannelHost`. The visible assignment prompt contains supplied task identity, goal, instructions, input, context, attempt mode, retry lineage, and resolved artifact paths in deterministic order. Separate hidden guidance explains participation rules without pretending to be user-authored text.

After preflight, Session binding, assignment persistence, and deadline synchronization succeed, the Synergy Clarus provider is the sole owner that sends `clarus.runtime.task.accept` with `run_id`, `project_id`, `task_id`, `subtask_id`, and `attempt` immediately before the first Session wake. The Holos CLI performs no Assignment accept or nack and never opens another Agent Tunnel. The Assignment event request ID is reused as the stable accept request ID. The existing native request path correlates `clarus.runtime.task.accepted`, validates all five task identity fields, and treats `accepted_at` as authoritative evidence; the provider does not wait for that response before waking the Session. Transport uncertainty records a bounded durable `ambiguous` Channel diagnostic without blocking local work or result submission. During one live connection, exact replay creates no second Session or inbox delivery, skips preflight and first-work wake, and only resends accept while no correlated acknowledgement has been observed.

Synergy declares an exact `@sii-holos/holos-cli` runtime dependency. Source runs resolve that package directly; standalone runtime builds copy its executable modules and required `ws` / `zod` dependencies into `lib/holos-cli`, and Desktop copies the complete runtime directory into application resources. This companion performs bounded REST preflight only. It does not install at first use, depend on the user `PATH`, open another Agent Tunnel, or own a parallel Clarus lifecycle.

Every installation also ships `clarus-agent-participation` as a memory-backed builtin Skill. It documents only the native assignment Session workflow and the `clarus_submit_task_result` / `clarus_extend_task` tools; it does not install a standalone listener, open another WebSocket, own credentials, or depend on external scripts.

Each running assignment may have one deterministic deadline Agenda item. The item belongs to the assignment Session's Project Scope and uses `session_guidance` delivery. It fires once, exactly three minutes before the current deadline; if the assignment arrives or is extended with less than three minutes remaining, it fires as soon as safely possible before the deadline. Once the deadline has passed, Synergy does not create or fire another reminder. When it fires, it injects hidden system-origin `steer` guidance into the same Task Session instead of creating a visible user prompt or a second Agenda Session. An acknowledged or authoritative extension reschedules the same Agenda item for the new deadline. Result acknowledgement or explicit Session abort cancels the reminder.

## Results and Extensions

`clarus_submit_task_result` and `clarus_extend_task` are available only inside a running Clarus assignment Session. Both validate bounded payloads and persist an outbox record before dispatch. Extensions add an integer from 60 through 3600 seconds, matching the upstream contract. Definitive extension rejection errors expose only a bounded, control-character-free, secret-redacted upstream code and message so the agent can correct the request without leaking untrusted content.

Result and extension state machines are independent. Each request records its request ID and settles as `acknowledged`, `not_dispatched`, `rejected`, or `ambiguous`:

- only the latest matching request may update assignment state;
- only `not_dispatched` records may be retried automatically after reconnect;
- a retry gets a fresh request ID and preserves prior-request lineage;
- a persisted `pending` record found after process interruption becomes `ambiguous` because dispatch cannot be disproved;
- `rejected`, `ambiguous`, and `acknowledged` records never auto-retry;
- correlated authoritative acknowledgement settles the matching outbox record;
- stale run, task, subtask, or request identities are ignored.

Remote Project pause does not invalidate work that was already accepted: the running Task may still extend its deadline or submit its result. Explicit Session abort marks the local assignment cancelled and cancels its deadline item, but preserves result and extension history for audit and recovery.

## Diagnostics, Refresh, and Product Projection

Channel diagnostics are durable per-account bounded records. Secret-like values are redacted, oversized records are truncated with metadata, retention is capped by age and count, and records remain downloadable while the account is disconnected or after restart. Invalid Clarus event schemas produce structured warning diagnostics containing only bounded event type, issue path, and issue message fields; the raw event payload is never recorded. Expired assignment skips and archived-Session blocks record only hashed remote identities plus the deadline or local Session identifier needed to diagnose the disposition.

`channel.refreshProjects` is a one-shot operation that resolves only after remote discovery, local Project reconciliation, active-Project subscription, and outbound recovery finish. Concurrent requests for one account and connection share the same in-flight Promise. While an account is `waiting_for_transport` or `connecting`, the route returns a structured retryable `409 ChannelRefreshUnavailable` conflict containing the current status instead of recording a generic server failure. Clarus bounds the complete manual refresh to 60 seconds and each Project subscription acknowledgement to 15 seconds, so the Settings action leaves `syncing` in a bounded time. Success reaches `connected`, provider failure reaches `failed`, and disconnect or reconnect preserves the newer connection lifecycle instead of allowing stale refresh completion to overwrite it. A failed or partial refresh reports the terminal error without destructive negative reconciliation.

The Sidebar groups managed Projects under Channel account rows. Feishu conversation Sessions are queried globally across Home and Project Scopes with a Feishu provider filter, while managed Task Sessions remain visible only beneath their canonical managed Project. Account state distinguishes disabled, waiting for borrowed transport, disconnected, syncing, connected, failed sync, and degraded operation. Provider capabilities determine whether refresh and diagnostic download actions are visible.

Settings refetches canonical Channel status on `channel.connected` and `channel.disconnected`, so an open account panel converges without requiring the user to reopen it or trigger Project refresh.

Feishu keeps unsupported image-format adaptation inside the provider boundary. Outbound SVG attachments remain canonical file parts in Channel core; the provider renders a bounded PNG preview in an isolated Worker with a five-second hard timeout, bundled Noto Sans SC fallback fonts for Latin and Simplified Chinese text, and no dependency on host system fonts. It sends the preview before the byte-identical SVG file. Preview conversion, upload, or delivery failure is non-fatal and preserves file delivery.

## Invariants

- Channel core owns Scope and Session integration; providers own remote protocol state.
- A managed external Project maps to one deterministic real Project Scope and never to a synthetic Project conversation Session.
- A remote Task maps to one ordinary unattended Session inside its managed Project Scope, and that Session appears beneath the managed Project even though its navigation category is `channel`.
- New endpoint identities use typed Channel targets; existing Feishu chat keys remain byte-for-byte compatible.
- Borrowed providers never create or reconnect their borrowed transport; provider initialization failures may use Channel's bounded retry backoff.
- Conversation providers release their ingress lane only after durable acceptance, track background execution through account drain, and use `SessionInbox` as the sole durable busy-session queue.
- Durable outbound state is written before send, and ambiguous dispatch is never retried automatically.
- Foreground conversation replies are delivered exactly once: while a streaming card owns a root's terminal reply, the outbound bridge skips that root; after delivery the bridge persists `channelOutboundSent` so queued, recovered, or late metadata updates never re-deliver the same answer.
- Remote archive preserves local Scope data but blocks new Task delivery.
- An expired assignment creates no Session or assignment binding; an archived owning Session blocks replay without replacement.
- Deadline guidance is hidden Session context, not a visible user prompt.
- Navigation and account actions derive from canonical Channel, Scope, Session, and API state rather than a provider-specific frontend store.
