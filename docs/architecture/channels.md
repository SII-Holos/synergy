# Channels

## Ownership

The Channel domain adapts external accounts into Synergy-owned Scope and Session behavior. Providers own remote protocol details; Channel core owns target identity, account lifecycle, managed Project ownership, task routing, diagnostics, and integration with the durable Session inbox.

Channels support two provider shapes:

- `chat` providers translate remote conversations into endpoint Sessions with replies, media, reactions, streaming, and provider-owned reconnect behavior.
- `task_only` providers discover remote Projects and dispatch remote Tasks into dedicated Synergy Sessions. They do not create a Project conversation or expose chat reply/push behavior.

Feishu is a `chat` provider with a `self_connected` lifecycle. Clarus is a `task_only` provider with a `borrowed_transport` lifecycle over the existing Holos Agent Tunnel.

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

Project targets identify managed ownership and navigation. A task-only provider does not materialize them as conversation Sessions.

Target keys include provider type and account ID. Project and Task identities therefore cannot collide with chat identities or with another account's external IDs.

Existing Feishu endpoint records retain the legacy `chatId` / `scopeKey` encoding. `Channel.Info` accepts exactly one identity form: the legacy chat fields or a typed target. This preserves existing Feishu keys while preventing new callers from mixing the two contracts.

## Provider and Transport Lifecycle

Every provider declares one lifecycle:

- `self_connected` providers own their transport and use Channel's bounded exponential reconnect loop.
- `borrowed_transport` providers observe a transport owned by another runtime and never install a second reconnect loop.

Clarus borrows the one authenticated Holos Agent Tunnel WebSocket through `HolosRuntime.getNativeTunnel()`. Native requests and unsolicited events carry the active agent identity, tunnel epoch, and monotonic connection generation. The port owns request validation, correlation, observer cleanup, and transport disposition:

- `not_dispatched` means bytes were not sent and an explicit retry may be safe.
- `rejected` is an authoritative terminal rejection.
- `ambiguous` means dispatch may have occurred; automatic retry is forbidden.

Disconnect settles in-flight native requests as ambiguous and notifies borrowed consumers. Clarus removes its observers and waits for Channel/Holos lifecycle to reconnect it; it does not create another WebSocket or reconnect loop.

## Managed Project Ownership

A task-only provider maps each `(channelType, accountId, externalProjectId)` identity to one real Project Scope through `ManagedProjectOwnership`.

The owner:

1. hashes the complete external identity;
2. creates a deterministic workspace under `data/channel/workspaces/<identity-hash>/workspace`;
3. rejects path escape, non-directory components, and symbolic links;
4. initializes that workspace as an independent Git repository without inheriting an ancestor `.git`;
5. resolves the workspace into a normal Project Scope;
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

`host.projects` owns:

- idempotent ensure of active or paused managed Projects;
- complete versus partial reconciliation;
- stale and archived transitions.

`host.tasks.dispatch` owns Task Session creation and delivery:

- it requires active owned Project state;
- it resolves the managed Project Scope;
- it keys one endpoint Session by provider, account, external Project, and external Task;
- it creates that Session with `autonomous` control and unattended interaction;
- it delivers the assignment as a visible `task` inbox item;
- it may deliver separate hidden system-origin participation guidance as a deduplicated `steer` item;
- it persists provider assignment state before waking the Session loop.

Exact assignment replay reuses the Session and delivery key. A new run for the same external Task reuses the Task Session with a new delivery. A retry represented by a new external Task ID creates a new Session and retains retry lineage.

`host.tasks.update` sends a deduplicated visible `steer` item only when the owned Project and Task Session still exist. Archived remote Projects never receive dispatch or update delivery.

## Native Clarus Task Flow

Clarus account configuration lives in the Channel domain and uses the active Holos agent credentials. The configured account ID must equal the active Holos agent ID, and the Agent Tunnel must already be connected.

On connect or manual refresh, Clarus:

1. lists all visible Projects through the Clarus REST API;
2. reconciles the complete snapshot into managed Project ownership;
3. subscribes to each active Project and waits for its correlated subscription acknowledgement;
4. recovers eligible result and extension outbox records.

The provider accepts only subscription state and runtime Task events. Legacy Project message, file, system, and notary events are not Channel behaviors and are classified as unknown by the task-only adapter.

`clarus.runtime.task.assigned` dispatches a Task Session through `ChannelHost`. The visible assignment prompt contains supplied task identity, goal, instructions, input, context, attempt mode, and retry lineage in deterministic order. Separate hidden guidance explains participation rules without pretending to be user-authored text.

Each running assignment may have one deterministic deadline Agenda item. The item belongs to the assignment Session's Project Scope and uses `session_guidance` delivery: when it fires, it injects hidden system-origin `steer` guidance into the same Task Session instead of creating a visible user prompt or a second Agenda Session. Authoritative extension events update the assignment deadline and reschedule the same Agenda item. Result acknowledgement or explicit Session abort cancels the reminder.

## Results and Extensions

`clarus_submit_task_result` and `clarus_extend_task` are available only inside a running Clarus assignment Session. Both validate bounded payloads and persist an outbox record before dispatch.

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

Channel diagnostics are durable per-account bounded records. Secret-like values are redacted, oversized records are truncated with metadata, retention is capped by age and count, and records remain downloadable while the account is disconnected or after restart.

`channel.refreshProjects` starts a coalesced background refresh and returns accepted without waiting for remote discovery. Concurrent refresh requests share one provider sync. A failed or partial refresh reports status without archiving Projects that were merely absent from an incomplete snapshot.

The Sidebar groups managed Projects under Channel account rows. Account state distinguishes disabled, waiting for borrowed transport, disconnected, syncing, connected, failed sync, and degraded operation. Provider capabilities determine whether refresh and diagnostic download actions are visible.

## Invariants

- Channel core owns Scope and Session integration; providers own remote protocol state.
- A managed external Project maps to one deterministic real Project Scope and never to a synthetic Project conversation Session.
- A remote Task maps to one ordinary unattended Session inside its managed Project Scope.
- New endpoint identities use typed Channel targets; existing Feishu chat keys remain byte-for-byte compatible.
- Borrowed providers never create a second transport or reconnect loop.
- Durable outbound state is written before send, and ambiguous dispatch is never retried automatically.
- Remote archive preserves local Scope data but blocks new Task delivery.
- Deadline guidance is hidden Session context, not a visible user prompt.
- Navigation and account actions derive from canonical Channel, Scope, Session, and API state rather than a provider-specific frontend store.
