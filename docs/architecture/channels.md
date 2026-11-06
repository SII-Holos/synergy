# Channels

## Ownership

The Channel domain adapts external accounts into Synergy-owned Scope and Session behavior. Providers own remote protocol details; Channel core owns target identity, account lifecycle, managed Project ownership, task routing, diagnostics, and integration with the durable Session inbox.

`channels` owns the provider-neutral runtime and requires only Local Runtime. Provider and neighboring account domains are independent packages:

| Component        | Required product capabilities | Owned behavior                                                          |
| ---------------- | ----------------------------- | ----------------------------------------------------------------------- |
| `channel-feishu` | Channels                      | Feishu transport, account schema, setup, tools and SVG rendering assets |
| `github`         | Local Runtime                 | GitHub credentials and connected account configuration                  |
| `channel-github` | Channels, GitHub              | Repository event polling, Channel ingress and dispatch agents           |
| `email`          | Local Runtime                 | Email accounts, credentials, service, tools and HTTP routes             |

`connectionComponents()` in `packages/connections` is an assembly facade returning these independent factories, including Channels. Its pure compatibility exports do not register providers. Channels registers only explicitly selected provider schemas, CLI setup choices, factories and tools. The `boss-feishu` and `github-agenda` bridges own the respective cross-domain behavior and declare both sides as requirements. The named `channel-blueprint`, `channel-light-loop` and `channel-lattice` bridges explicitly register `/blueprint` (`/plan`), `/lightloop` and `/lattice` with `ChannelCommand`. A registered workflow descriptor alone does not expose a Channel command or help entry. Full composition selects all three; standalone Channels selects none.

An unloaded provider has no transports, reconnect loops, tools, HTTP features, settings schema or CLI setup choice. Retained account configuration and managed resource data are preserved for reinstallation. Public resolved configuration exposes selected provider records only; editing one selected provider must preserve stored records belonging to unloaded providers. Runtime registration, shutdown and failed startup are isolated to the selected instance.

Email keeps each SMTP pool and its idle timer inside the owning Runtime. Successful sends renew the idle deadline; credential changes and transport failures discard that pool. Component disposal closes the pool and cancels its timer, with idempotent cleanup that leaves other Runtimes connected.

Channels startup status polling belongs to its Runtime. Completion, timeout and disposal cancel both the poll and its deadline. A cancelled status request returns no rows and cannot install subscriptions after Scope disposal.

Providers report typed ingress facts through `ChannelHost` and may support one or both ingress families:

- Conversation ingress translates remote messages into endpoint Sessions through `host.conversations.receive()`. Matching provider capabilities may supply replies, proactive pushes, media, reactions, and streaming.
- Project and Task ingress reports discovery and assignments through `host.projects` and `host.tasks`. Project discovery does not create a conversation Session; Task assignments use dedicated Task Sessions.

Ingress families are capabilities, not mutually exclusive provider kinds. A provider may support both. Feishu currently exposes conversation ingress with a `self_connected` lifecycle. GitHub exposes conversation ingress with a `self_connected` lifecycle: it polls the GitHub REST API outbound (no inbound webhook), synthesizes repository events (`issue.opened`, `pull_request.opened`, `pull_request.synchronize`, `comment.created`), and delivers them through `host.conversations.receive()` with `chatId = "owner/repo#<number>"`. Comments only wake an agent on an explicit mention of the bot handle (the GitHub App slug by default), and each issue/PR thread resolves to its own random-hash checkout directory Scope via the provider's `resolveConversationScope()` hook. See [GitHub Channel](github-channel.md).

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

Managed Project Scopes are projected in navigation under their Channel account and excluded from the generic Projects section. This projection is derived from canonical Scope navigation metadata; the frontend does not maintain a provider-specific Project store.

## ChannelHost Boundary

Providers receive an account-bound `ChannelHost` rather than direct Scope or Session constructors.

Conversation ingress separates durable acceptance from execution. `host.conversations.receive()` returns an acceptance result whose `execution` Promise owns streaming and generation. A provider lane waits only until Channel core has resolved the endpoint Session and either reserved its loop lease or durably written the request to `SessionInbox`; it tracks accepted execution separately for bounded account drain. Feishu serializes this acceptance by its existing conversation key, preserving same-topic order and different-topic parallelism without creating a provider-owned durable queue.

`StreamingSession.close()` owns terminal delivery and may use a provider's cached answer or fallback. `closeWithoutDelivery()` is a separate required resource-finalization operation: it stops streaming without rendering cached/terminal content or sending a fallback reply. Channel core uses it when post-invoke history is unavailable and cannot safely classify a terminal. Feishu only closes streaming-mode settings with an empty summary; it does not retract progress already streamed. A live writer may finish its already-captured snapshot, but a render waiting for pacing must recheck admission before capturing content. Cleanup shares the session's single-flight close promise, and core releases foreground ownership and subscriptions even when the provider rejects cleanup.

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
- it creates that Session with the configured non-interactive control profile (default `autonomous`) and unattended interaction;
- it delivers the assignment as a visible `task` inbox item;
- it may deliver separate hidden system-origin participation guidance as a deduplicated `steer` item;
- it persists provider assignment state before waking the Session loop.

Exact assignment replay reuses the Session and delivery key.

`host.tasks.update` sends a deduplicated visible `steer` item only when the owned Project and Task Session still exist. Archived remote Projects never receive dispatch or update delivery.

## Diagnostics, Refresh, and Product Projection

Channel diagnostics are durable per-account bounded records. Secret-like values are redacted, oversized records are truncated with metadata, retention is capped by age and count, and records remain downloadable while the account is disconnected or after restart.

`channel.refreshProjects` is a one-shot operation that resolves only after remote discovery, local Project reconciliation, active-Project subscription, and outbound recovery finish. Concurrent requests for one account and connection share the same in-flight Promise. While an account is `waiting_for_transport` or `connecting`, the route returns a structured retryable `409 ChannelRefreshUnavailable` conflict containing the current status instead of recording a generic server failure. Success reaches `connected`, provider failure reaches `failed`, and disconnect or reconnect preserves the newer connection lifecycle instead of allowing stale refresh completion to overwrite it. A failed or partial refresh reports the terminal error without destructive negative reconciliation.

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
- Foreground and recovered terminals share `delivery-plan.ts` and `delivery.ts`. Plans classify each terminal and its generation segment from one operation-local target-turn body read. `SessionHistory.turnInfos()` enumerates terminals and rechecks markers and effective-history membership under the root delivery lock without hydrating bodies. Ordinary terminals on either side of a reaction retain independent delivery, attachment deduplication and response-card registration. Cancellation releases temporary plans; disposing the outbound bridge cancels pending reads before dispatch.
- The selected Feishu component owns reaction-only tool availability and the post-model termination job; Agent workers use the same registration entry point. Unselected providers contribute neither tools nor jobs.
- A reaction-only terminal (Feishu, opted-in non-streaming accounts) is exclusive: its intent belongs to the selected terminal assistant, targets the user's own inbound message rather than the reply anchor, and posts nothing on either delivery path. A durable root-scoped attempt precedes the provider effect; delivered, failed, or ambiguous attempts are never automatically repeated. Repeated intent-bearing terminals stay silent, but root-level idempotency markers do not suppress ordinary answers in either order with reaction-only steers. Foreground delivery processes all newly completed terminals owned by its root even if a later queued root fails, rather than using the inbox drain's last result. Error or paused assistants cannot become successful reaction terminals; uncertain provider outcomes never append an ERROR reaction.
- Remote archive preserves local Scope data but blocks new Task delivery.
- An expired assignment creates no Session or assignment binding; an archived owning Session blocks replay without replacement.
- Deadline guidance is hidden Session context, not a visible user prompt.
- Navigation and account actions derive from canonical Channel, Scope, Session, and API state rather than a provider-specific frontend store.
