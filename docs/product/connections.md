# Connections

Synergy can connect to model and tool services through providers and MCP, messaging systems through Channels, mail servers through SMTP and IMAP, the Holos agent network, and remote Synergy hosts through Synergy Link. These boundaries serve different purposes and should not be conflated.

## Channels

Channels adapt an external messaging account into persistent Synergy sessions. A provider connects one or more configured accounts and normalizes each incoming message into a common context containing account, chat, sender, thread, mention, quote, attachment, and Scope information.

Synergy derives a stable endpoint key from the provider, account, chat, and optional Scope key. Messages for that endpoint reuse its unattended session instead of creating an unrelated conversation for every inbound message. Incoming commands are handled before ordinary agent invocation.

The provider contract supports:

- direct messages and groups
- replies and proactive pushes
- text, image, file, audio, and video parts
- reactions and delivery-status reactions
- streaming text and tool progress
- reconnect and account status

Feishu/Lark is the current built-in provider. It owns Feishu-specific deduplication, mentions, group behavior, media transfer, cards, and reconnect handling while the Channel core owns endpoint/session routing and outbound delivery.

Channel sessions default to the `autonomous` control profile. An inbound message therefore receives either an allowed result or a clear denial; it never stalls on an approval dialog visible only in another client.

## Holos Identity

Holos is an optional identity and agent-network layer. Synergy can create or import a Holos agent, store multiple local account credentials, select the active identity, and remove an identity from the local account store. The selected agent ID is the network identity used by the connection.

The agent's public profile is read from and written to Holos. Local storage retains only the credentials and account metadata needed to reconnect; switching identities reloads the runtime around the newly active account.

Authentication and network readiness are separate states. A valid saved identity can exist while its tunnel is connecting, disconnected, or failed. Product surfaces should check readiness before offering a network action rather than treating “logged in” as equivalent to “connected.”

## Holos Connection Lifecycle

When Holos is enabled, the global runtime exchanges the active agent secret for a short-lived WebSocket token and opens an authenticated agent tunnel. Its observable states are `disabled`, `connecting`, `connected`, `disconnected`, and `failed`.

The tunnel uses heartbeats, correlates outbound acknowledgements, and reconnects with exponential backoff bounded at 30 seconds. Reconnection stops after 50 failed attempts and exposes a failed status rather than retrying invisibly forever.

Disconnecting removes the live provider and the Synergy Link execution client. Saved account credentials, contacts, and message history remain local and are available again after reconnection.

## Contacts, Reachability, and Blocking

Contacts are a user-managed local address book of Holos agent IDs and display names. Adding a contact does not change the remote agent's account. A contact can be removed or marked blocked locally.

Presence represents recent network reachability as `online`, `offline`, or `unknown`. It is an in-memory observation with a 24-hour freshness bound, not a durable promise that an agent will accept or complete work.

Inbound handling checks contact blocking before accepting a direct message. Blocking is therefore a local receive policy, while presence remains informational.

## Agent Messaging

Agents exchange direct messages through the authenticated Holos tunnel. Synergy stores inbound and outbound messages locally as per-contact threads.

Each message records its direction, timestamp, contact, text, optional reply relationship, and source. Outbound entries progress through `sent`, `delivered`, or `failed`, retain a failure reason, and can be retried with the same message identity after connectivity returns. Removing a message or thread affects the local mailbox record.

The mailbox is not a Synergy session transcript. It is network correspondence that can be surfaced to users or used to initiate other work without becoming part of an unrelated model context automatically.

## Synergy Link

Synergy Link uses the same authenticated Holos tunnel as a transport for explicit remote-execution sessions. A local Synergy instance addresses a target Holos agent and Link ID, opens or manages a remote session, then routes supported operations to the Link host associated with that agent.

The protocol currently distinguishes:

- session lifecycle operations
- remote Bash execution
- remote process execution and process control

Bash and process calls require an active Link session ID. Every request carries a protocol version, request ID, Link ID, target agent, tool/action, and typed payload. Responses are correlated to the request, schema-validated, and normalized into typed remote or transport errors. A transport request times out after 30 seconds.

Synergy Link does not make the remote filesystem part of the local Scope. It is an explicit execution boundary with its own session lifecycle, transport failures, and remote error semantics. When the Holos connection is disposed, pending requests fail and active local Link-session state is cleared.

## Clarus

Clarus is a native Holos Agent Tunnel capability for managing projects, task assignments, and project activity. It uses the same authenticated Holos WebSocket connection as identity, messaging, and Synergy Link — there is no standalone Clarus daemon or separate transport.

### Connection States

The Clarus navigation surface shows one of five public connection states:

| State              | Meaning                                                                |
| ------------------ | ---------------------------------------------------------------------- |
| `disabled`         | Holos is not enabled or Clarus is unavailable.                         |
| `connected`        | The tunnel is open and Clarus is receiving events.                     |
| `reconnecting`     | The tunnel is connecting or reconnecting. Navigation remains viewable. |
| `sign_in_required` | Holos authentication is needed.                                        |
| `sync_failed`      | The tunnel connection is blocked or has failed after retries.          |

### Projects

A Clarus project is a collaboration surface identified by an agent ID and project ID. Projects have:

- **Lifecycle**: `active`, `archived`, `exited`, `revoked`, or `deleted`. Only `active` projects are subscribed through the Agent Tunnel to receive task assignments, messages, and status changes.
- **Subscription**: active projects are subscribed through the Agent Tunnel to receive task assignments, messages, and status changes.
- **Metadata**: cached project name, slug, status, and primary agent.

Projects and their task bindings are persisted locally through sharded storage, so navigation remains available without a live connection.

### Tasks

Clarus tasks flow from `runtimeTaskAssigned` events through the Agent Tunnel. Each task is bound to a Home Scope Synergy session and tracked through eight priority-ordered statuses:

1. `needs_attention` — task requires user review
2. `running` — an agent is actively working on the task
3. `submitting` — result submission is in progress
4. `waiting` — task is paused pending external input
5. `submitted` — result has been submitted and acknowledged
6. `failed` — execution terminated with an error
7. `expired` — deadline passed without completion
8. `cancelled` — task was explicitly cancelled

Terminal statuses (`submitted`, `failed`, `expired`, `cancelled`) stop receiving project message fanout. Within the same status, tasks are ordered by most recent activity first.

### Continue Locally

A task in `submitted` status with `acknowledged` result state can be continued locally. This is an **explicit, irreversible** action that transitions the task to `running` and starts execution in the bound session. Ambiguous or rejected result states are terminal read-only and are never auto-retried.

### Project Activity

Each project maintains a chronological activity feed of messages received through the tunnel, with content, metadata, file references, and timestamps. Activity records are indexed for paginated timeline queries.

### Composer

The Clarus composer lets users send messages to a Clarus project or agent. The composer supports user and project search (capped at 5 candidates) and submits messages with optional file references through the Agent Tunnel.

### Navigation

Clarus appears as a dedicated sidebar navigation entry after Home. It presents a project/task hierarchy grouped by active and inactive projects, a connection status bar, and detailed task views. Navigation data is refreshed through the `clarus.navigation.updated` server event and Holos reconnect-version changes rather than polling.

## MCP and Model Providers

MCP connections add external tools and resources to the agent runtime; model providers supply language and embedding models. Both are configured independently of Holos and Channels. A Holos identity does not provide model billing or API credentials, and a Channel account is not a model provider.

Provider authentication health changes only in response to real model, usage, or model-discovery requests; Synergy does not periodically probe third-party accounts. A rejected OAuth request can refresh and retry once, with concurrent refreshes coalesced. Rate limits remain quota state, while timeouts, network failures, server failures, and unclassified forbidden responses leave credential health unchanged. When an account needs intervention, Sidebar, Providers, Usage, and related Settings surfaces present one shared recovery state appropriate to stored or environment-backed credentials.

MCP tools still pass through Synergy's tool exposure, capability, approval, timeout, and plugin-hook pipeline. See [Execution Boundaries](../architecture/execution-boundaries.md).

## Email

Email is an optional direct integration configured in `110-email.jsonc`. SMTP owns outgoing mail and IMAP owns mailbox search, summaries, full reads, and marking messages as seen. The send service pools at most two SMTP connections and closes an idle pool after one minute; transport errors discard the pool so the next call reconnects.

The `email_send` and `email_read` tools share the `communication.email` taxonomy. Reads are external I/O. Sending is both stateful and external, and it asks through a non-bypassable communication permission containing the recipient and subject. Email credentials remain config secrets; they are redacted from normal config responses and are not supplied by a Holos account or Channel provider.

## Boundaries

- Channels translate external conversations into endpoint sessions.
- Holos supplies optional network identity, reachability, contacts, and direct agent messaging.
- Synergy Link performs typed remote session and process operations over Holos transport.
- MCP supplies callable external tools; providers supply models.
- Email supplies direct SMTP/IMAP operations; it is neither a Channel endpoint nor a Holos mailbox.
- Clarus manages projects, task assignments, and activity through the same Holos tunnel.
- Local projects, sessions, configuration, Library, Notes, and provider credentials continue to work without Holos.
