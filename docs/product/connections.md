# Connections

Synergy can connect to model and tool services through providers and MCP, messaging systems through Channels, mail servers through SMTP and IMAP, the Holos agent network, and remote Synergy hosts through Synergy Link. These boundaries serve different purposes and should not be conflated.

## Channels

Channels connect external accounts to the same durable Scope, Session, inbox, and permission model used by interactive clients. Channel core owns account lifecycle, endpoint target identity, Scope and Session routing, managed Project ownership, and diagnostics. Each provider owns its remote protocol and provider-private state.

A provider reports typed ingress facts through the account-bound Channel host. Synergy derives a stable endpoint key from the provider, account, chat, and optional Scope key. Messages for that endpoint reuse its session instead of creating an unrelated conversation for every inbound message. Incoming commands are handled before ordinary agent invocation.

- Conversation ingress maps remote messages to stable unattended Sessions through `host.conversations`. Provider conversation capabilities may support replies, proactive pushes, media, reactions, and streaming progress.
- Project and Task ingress reports discovery and assignments through `host.projects` and `host.tasks`. Discovery never creates a Project conversation Session, and Project-level protocol events never invoke a model.

These ingress families are capabilities rather than exclusive provider kinds, so one provider may support both. Each provider capability may include:

- direct messages and groups
- replies and proactive pushes
- text, image, file, audio, and video parts
- reactions and delivery-status reactions
- streaming text and tool progress
- reconnect, account status, and awaitable account shutdown
- provider-native response cards with buttons and bounded static selects
- provider-native question forms for interactive sessions and continuations

Feishu/Lark is the built-in conversation provider. It retains its existing chat endpoint keys, default Home Scope, configured project Scope routing, media and mention handling, cards, and self-connected lifecycle while Channel core owns endpoint and Session routing.

Feishu streaming cards replace accumulated progress with the terminal assistant answer when the run completes. CardKit writes are successful only when both the HTTP response and Feishu response code succeed. If card startup fails, the Channel turn continues and sends its terminal answer through the ordinary reply API. Each active card ID is persisted independently before the card is exposed in chat; reconnect closes cards orphaned by a prior process before accepting new events without letting newer turns overwrite failed recovery state. If terminal card finalization fails, the provider also sends the terminal answer through the ordinary message API instead of leaving the user with a stale progress card.

Ordinary outbound text (terminal answers delivered outside an active streaming card, proactive pushes, and non-streaming fallbacks) defaults to a CardKit card with a single markdown element so Feishu renders the assistant's formatting. `responseFormat: "text"` on an account or the provider restores plain text messages. Markdown image references (`![alt](https://...)`) are downloaded and uploaded to Feishu as `image_key`s so the card can render them; images that fail to download, return a non-image content type, or use a non-HTTP destination degrade to a plain link (or alt text) without failing the card. Markdown delivery falls back to plain text when the serialized card exceeds the 30 KiB card budget or the card API fails, and media attachments keep their native message types either way.

Stopping or replacing a Feishu/Lark account first stops new inbound admission, closes the websocket, flushes pending debounce groups, and drains accepted inbound work plus per-chat tasks to a fixed point. Channel lifecycle operations await that provider drain, bounded by a 30-second provider timeout, before publishing the disconnected state.

Feishu/Lark distinguishes Synergy's own bot messages from messages sent by other bots using the authenticated account's `botOpenId`. The provider resolves that identity from account configuration or the Feishu bot-info API and fails closed for bot senders while it is unknown. With `requireMention: true`, an external bot message is accepted only when it contains a real mention whose open ID matches Synergy; the Feishu app also needs the bot-to-bot group mention event permission. Set `groupSessionScope` to `group_topic_sender` to isolate bot-bot interactions per topic per sender.

`groupSessionScope` accepts five strategies: `group` shares one session across the chat; `group_sender` isolates each sender; `group_topic` isolates each topic or thread; `group_topic_sender` isolates each sender within a topic or thread; and `group_thread` keeps one session per Feishu thread. Topic-aware modes fall back to their non-topic equivalent when the message has no topic identifier.

With `group_thread`, `thread_id` is the only continuity key. A message inside a thread resumes the session bound to that thread; a top-level message with no `thread_id` starts one session per message. `root_id`, `parent_id`, and quoted content are treated as context only and never select the session. The first response is sent with `reply_in_thread: true`, and the `thread_id` returned by Feishu is durably bound to the session so later messages in that thread reuse it.

Each Feishu/Lark account can optionally set `projectDir` to bind its sessions to a project Scope. The directory is resolved relative to the Synergy home directory unless absolute. It must exist, be readable, and resolve to a project Scope (as determined by `Scope.fromDirectory()`). A missing, unreadable, or non-project directory fails the account connection at startup. When `projectDir` is omitted, the account uses the home Scope. All endpoint sessions for that account are scoped to the resolved Scope, so session history, notes, Library, and files are consistent per account.

Each Feishu/Lark account can set a default model and one of that model's exposed variants. The account selection is written onto each inbound root message so the session header and provider request agree. A conversation-level `/model` override takes precedence over the account default; because that override selects a different model, it does not inherit the account model's variant.

Channel sessions default to the `autonomous` control profile. An inbound message therefore receives either an allowed result or a clear denial; it never stalls on an approval dialog visible only in another client.

### Channel Commands

Channel commands are handled before ordinary agent invocation. Commands that accept trailing text can switch or reset the conversation and immediately continue that text as the next user request.

| Command                       | Aliases                               | Behavior                                                                                                         |
| ----------------------------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `/chat [message]`             | —                                     | Switches the conversation to normal chat; optional trailing text continues immediately.                          |
| `/blueprint [request]`        | `/plan`                               | Enables Blueprint planning; optional trailing text is handled as the planning request.                           |
| `/lightloop <task>`           | —                                     | Starts or updates Light Loop with the required task text and continues that task immediately.                    |
| `/lattice [goal]`             | —                                     | Enables automatic Lattice decomposition; optional trailing text continues as the goal.                           |
| `/model <providerID/modelID>` | —                                     | Changes the model override for an existing conversation.                                                         |
| `/new [message]`              | `/reset`, `/重置`, `/清空`, `/新对话` | Archives the endpoint's current session; optional trailing text starts the replacement conversation immediately. |
| `/status`                     | `/状态`                               | Reports whether a conversation exists and, when it does, its message count and timestamps.                       |
| `/help`                       | `/commands`                           | Displays the command list in the Channel conversation.                                                           |

### Response Cards

Response cards let the agent present ordered text, buttons, and bounded static selects when structured presentation is clearer than plain text. In Feishu/Lark they appear as interactive CardKit messages; choosing a registered control starts a fresh Channel task after identity, message, action, value, deduplication, and expiry checks succeed.

The provider-neutral card intent is limited to 28 KiB. It does not support raw provider JSON, URLs, free-form inputs, commands, or arbitrary tool calls.

The Channel-only `response_card` tool produces a provider-neutral card intent; it does not send a message or execute an action itself. Channel delivery renders each completed intent through the active provider and durably registers it against the original task requester. Foreground and unattended delivery share the same registration, so a terminal task sends each card at most once even when both paths observe it.

Feishu/Lark renders response cards with CardKit v2. Callback envelopes use the built-in `response_card:` namespace. Synergy validates the account, chat, original requester, sent card message, registered control, submitted value, and 14-day expiry before accepting a callback. Invalid or expired built-in callbacks fail closed; unrelated callback namespaces continue to the existing plugin callback handlers.

An accepted callback never treats its opaque ID or value as a command, tool name, URL, or executable instruction. Synergy creates a fresh Channel user task whose visible text is synthesized only from the registered card title and labels. The raw callback fields remain in structured message metadata for audit and routing. Callback event IDs use durable inbox delivery keys, so retries enqueue one task and return a duplicate acknowledgement without invoking the model twice.

Response-card registration writes a pending record before the provider send and activates it only after receiving the sent message ID. If a process stops while the provider outcome is unknown, the surviving pending record blocks resend until its expiry rather than risk issuing a duplicate interactive card. Expired and malformed registrations are pruned at global runtime startup.

### Question Cards

Question Cards are a dedicated interactive surface for Feishu/Lark Channel sessions. When the agent asks a question during an inbound task or a later continuation, the runtime delivers a CardKit 2.0 form message instead of blocking on an unattended response. The form renders each question prompt with single-select or multi-select options and an optional free-text input.

Feishu/Lark is the current built-in provider that implements the optional `sendQuestionCard` provider method. Delivery renders the card from the same `Question.Request` that produced the blocking promise. A Scope-local Channel bridge remains subscribed after the inbound handler returns and resolves the account, chat, requester, and reply anchor from durable session endpoint and root-message metadata.

The callback envelope uses a distinct `synergy_question_card` namespace — separate from `response_card:` and plugin callback namespaces. The runtime validates the channel type, account ID, chat ID, original requester open ID, and the sent card message ID against the registration before accepting the callback. Registration is Scope-local through the provider's `onQuestionCardAction` callback, so the callback executes in the account's bound Scope. Mismatched or expired registrations are rejected.

An accepted callback maps opaque option indices back to the registered labels and resolves the original pending Question with the user's form selections. The runtime remembers the accepted callback event for the active session so an immediate provider retry returns a duplicate acknowledgement instead of resolving the Question again.

Provider delivery failure rejects the Question. Channels without a native question surface remain unattended and reject before delivery. Reply, reject, or timeout settles the active registration while the Scope-local bridge remains available for later questions in the same session. Serialized CardKit JSON plus a 2 KiB safety reserve must stay within the 30 KiB card budget.

### Outbound Delivery Anchoring

Outbound channel delivery uses a message-scoped reply anchor instead of a
generic push when the assistant message carries `channelReply: true`. Each
inbound Channel root user message records `channelReplyToMessageId` from the
provider root ID, or from the inbound message ID when no root exists. The
session endpoint remains stable when a Channel session is reused and does not
store or refresh this transient routing state.

`ChannelOutbound` reacts to terminal assistant messages. For each new terminal
assistant it:

1. acquires a lock on the message ID and re-reads the current metadata to
   prevent duplicate or stale delivery
2. checks for `channelPush`, `mailbox`, or `channelReply` metadata — without
   any of these, the assistant is not sent
3. when `channelReply` is true and no `channelReplyToMessageId` exists on that
   assistant, logs a warning and drops the message instead of pushing to the
   chat
4. delivers provider-native response cards and ordinary text/media parts; card-only terminal responses are valid outbound results. Tool-produced file, image, audio, and video attachments found across the completed task thread are projected into the same delivery, so attachment-only terminal responses are valid too
5. records `channelOutboundSent: true` after all matching cards are durably handled and ordinary provider delivery succeeds, so repeated terminal events do not send the result again

### Reply in Thread

The Feishu/Lark provider supports per-account `replyInThread: true` in account
configuration. When enabled, `provider.replyMessage()` includes
`reply_in_thread: true` in the request body so the reply appears in a thread
rather than at the top level of the chat.

### Continuation Delivery

`SessionInvoke` propagates channel delivery metadata through continuation
steps. When a steer message injected by Cortex (or another source) carries
`channelPush`, `channelReply`, and `channelReplyToMessageId`, every assistant
message produced in that continuation round inherits them. An unrelated user
message that starts a new task root does not inherit the delivery metadata. If
one continuation contains conflicting reply anchors, it keeps reply intent but
omits the target so outbound delivery fails closed instead of replying to the
wrong topic.

### Native Clarus tasks

Clarus is the built-in Project and Task provider and does not emit conversation ingress. A Holos identity creates its matching Channel account disabled by default; existing active identities receive the same account through the Holos migration runner. After the user enables it, Clarus borrows the existing authenticated Holos Agent Tunnel instead of opening another WebSocket or reconnect loop. The configured Clarus account must match the active Holos agent identity. While Holos is connecting or reconnecting, Clarus reports `waiting_for_transport` and waits without failing the Channel start.

Project refresh discovers all visible non-archived remote Projects and provisions one deterministic managed Project Scope per `(provider, account, external Project)` identity, including Projects that currently have no Tasks. These are normal Project Scopes with files, Git, LSP, configuration, and Sessions, but the Sidebar shows them only under their Channel account rather than duplicating them in the generic Projects section.

Remote Project state is displayed separately as active, paused, stale, or archived. Remote pause does not interrupt already accepted local work. Remote archive stops new assignment delivery but preserves the managed Scope, files, Sessions, task state, and result history. Active or remotely paused managed Projects cannot be locally archived; stale or remote-archived Projects use the normal local archive workflow.

Only a Clarus task assignment creates or wakes a Session. One external Task ID has one stable unattended Session in its managed Project Scope; another run of that Task reuses the Session, while a retry represented by a new Task ID creates a new Session and preserves lineage. Clarus Task Sessions use the `autonomous` control profile so remote work cannot stall on an approval dialog visible only elsewhere.

Task deadlines use durable Agenda guidance in the same Task Session. One hidden system-authored reminder steers the agent exactly three minutes before the current deadline, or as soon as safely possible when less than three minutes remain. It is not a visible user prompt or a second Agenda Session, and no reminder is sent after the deadline has passed. An acknowledged or authoritative extension reschedules the same reminder for the new deadline, result acknowledgement cancels it, and the standard Session Abort action stops local execution.

Result submission and deadline extension persist their outbound record before dispatch. Only a request known not to have been sent can retry automatically; rejected or ambiguous requests do not. Account actions expose coalesced **Refresh Projects** and bounded, redacted diagnostics download when the provider supports them.

See [Channels](../architecture/channels.md) for target identity, ownership, lifecycle, recovery, and diagnostics invariants.

## Holos Identity

Holos is an optional identity and agent-network layer. Synergy can create or import a Holos agent, store multiple local account credentials, select the active identity, and remove an identity from the local account store. The selected agent ID is the network identity used by the connection.

The agent's public profile is read from and written to Holos. Local storage retains only the credentials and account metadata needed to reconnect; switching identities reloads the runtime around the newly active account.

Authentication and network readiness are separate states. A valid saved identity can exist while its tunnel is connecting, disconnected, or failed. Product surfaces should check readiness before offering a network action rather than treating "logged in" as equivalent to "connected."

## Holos Connection Lifecycle

When Holos is enabled, the global runtime exchanges the active agent secret for a short-lived WebSocket token and opens an authenticated agent tunnel. Its observable states are `disabled`, `connecting`, `connected`, `disconnected`, and `failed`.

The tunnel uses heartbeats, correlates outbound acknowledgements, and reconnects with exponential backoff bounded at 30 seconds. Reconnection stops after 50 failed attempts and exposes a failed status rather than retrying invisibly forever.

Disconnecting removes the live provider and the Synergy Link execution client. Saved account credentials, contacts, and message history remain local and are available again after reconnection.

## Contacts, Reachability, and Blocking

Contacts are a user-managed local address book of Holos agent IDs and display names. Adding a contact does not change the remote agent's account. A contact can be removed or marked blocked locally.

Presence represents recent network reachability as `online`, `offline`, or `unknown`. It is an in-memory observation with a five-minute freshness bound, not a durable promise that an agent will accept or complete work.

Inbound handling checks contact blocking before accepting a direct message. Blocking is therefore a local receive policy, while presence remains informational.

## Agent Messaging

Agents exchange direct messages through the authenticated Holos tunnel. Synergy stores inbound and outbound messages locally as per-contact threads.

Each message records its direction, timestamp, contact, text, optional reply relationship, and source. Outbound entries progress through `sent`, `delivered`, or `failed`, retain a failure reason, and can be retried with the same message identity after connectivity returns. Removing a message or thread affects the local mailbox record.

The mailbox is not a Synergy session transcript. It is network correspondence that can be surfaced to users or used to initiate other work without becoming part of an unrelated model context automatically.

## Synergy Link

Synergy Link uses the same authenticated Holos tunnel as a transport for explicit remote-execution sessions. In the one-way A-controls-B model, A persists each remote host as a Link target with a stable local target ID, display name, target Holos agent ID, Link ID, enablement state, and optional local-agent allowlist. A does not copy or store B's Holos credentials; B remains responsible for approving, denying, or revoking access.

The Synergy Link Settings page creates and manages these targets. A successful connection or connection test records B's observed host session and capabilities, including platform, architecture, runtime, and shell support. These observations are metadata, not a guarantee of current reachability.

Agents use `connect list_targets` to discover only the enabled targets allowed for their agent name, then use the stable `targetID` for `connect`, `bash`, and `process` calls. Raw target agent and Link IDs remain available for legacy calls and manual diagnosis, but agents do not need them in the normal flow.

The protocol currently distinguishes:

- session lifecycle operations
- remote Bash execution
- remote process execution and process control

Bash and process calls require an active Link session ID. Every request carries a protocol version, request ID, Link ID, target agent, tool/action, and typed payload. The host derives an internal execution lease from the authenticated caller and validated session; that lease is never accepted from the wire payload. Remote process records and output are scoped to `sessionID + caller Agent ID + caller owner user ID`, every process read/control operation enforces the lease, and session close, kick, disable, or idle expiry terminates the session's process trees and removes its retained output. Duplicate request IDs within one execution lease reuse the original in-flight or completed result; reusing the ID for a different request is rejected. Responses are correlated to the request, schema-validated, and normalized into typed remote or transport errors. A transport request times out after 30 seconds. Remote Bash yield is capped at five seconds before auto-backgrounding so the process handle can return well before that deadline; callers should use the returned process ID for tracked long-running work. Any supplied remote selector is classified through the non-bypassable remote-execution capability, and invalid, disconnected, or sessionless selectors fail closed instead of running the command locally.

### Host Identity and Ownership Semantics

The Holos Agent ID is the device identity for a Link host. One physical or device instance (a container, VM, or bare-metal host) runs one Link host service bound to one Agent ID, and one Agent ID is active on exactly one device. The host persists its own Link ID (`link_…`), host session ID, label, owner registry, approval mode, trust list, and pending requests in its per-instance state root (`SYNERGY_LINK_HOME`, default `~/.synergy-link/`).

Ownership and reachability are verified, not assumed. A sender target records the host's observed Link ID, host session, platform, architecture, runtime, and shell support only after a successful connection or test; those observations are metadata about one authenticated contact, not a standing guarantee of reachability. A host identity mismatch (observed Link ID differs from the target) or a `refused` probe invalidates or revokes the target until it is re-tested. An active Link session is one session per host: the host reports `busy` while a session is open and `idle` otherwise.

Running the same Agent ID on two devices is unsupported. Holos tunnel routing is last-writer-wins — the most recently connected instance receives the traffic and the earlier instance silently loses reachability — and no local mechanism can reliably prevent or detect that race. Deployment must enforce one Agent ID per device; see [Qizhi Synergy Link operations](../operations/qizhi-synergy-link.md) for the shared-filesystem deployment, verification, and recovery runbook.

Host state is per-instance. Never share a writable `HOME`, the Synergy runtime home (`~/.synergy/`), Holos credential stores, `SYNERGY_LINK_HOME`, control sockets, PID files, logs, or temp directories between Link hosts. Shared read-only binaries and assets are acceptable. `SYNERGY_LINK_HOME` selects the host's state root; `synergy-link status`, `whoami`, and `doctor` interpret it. The host never stores the sender's credentials, and the sender never copies the host's Holos secret.

### Host CLI

The standalone `synergy-link` CLI manages the host:

- Service: `server [--print-logs]`, `start`, `stop`, `restart`, `status`, `logs [-f] [--tail N] [--since DURATION]`
- Identity: `login [--agent-id ID --agent-secret SECRET]`, `logout`, `whoami`, `reconnect`, `doctor`
- Collaboration: `mode <status|managed|standalone>`, `collaboration <enable|disable|status>`, `requests <list|show|approve|deny> [request-id]`, `session <status|kick|block>`, `approval <get|set <auto|manual|trusted-only>>`, `trust <list|add|remove> [agent|user] [value]`, `label <get|set <label>|clear>`

`doctor` checks configuration directory, mode, local owner, auth presence, service process, connection state, and — when credentials exist — validates the secret against Holos. Local ownership is not applicable in standalone mode and is required only for a managed owner lease. Credential import verifies both that Holos accepts the secret and that the authenticated `/me` Agent ID matches the supplied Agent ID before replacing stored credentials. `whoami` reports the logged-in agent, mode, ownership, Link ID, label, and service state. `status` requests live state through the host control socket and labels that output `live`; when the socket is unavailable it prints a clearly marked `snapshot (last-known)` with the control error and exits nonzero so automation cannot mistake stale state for current health.

### Boundaries

Synergy Link does not make the remote filesystem part of the local Scope. It is an explicit execution boundary with its own session lifecycle, transport failures, and remote error semantics. When the Holos connection is disposed, pending requests fail and active local Link-session state is cleared.

## MCP and Model Providers

MCP connections add external tools and resources to the agent runtime; model providers supply language and embedding models. Both are configured independently of Holos and Channels. A Holos identity does not provide model billing or API credentials, and a Channel account is not a model provider.

Provider authentication health changes only in response to real model, usage, or model-discovery requests; Synergy does not periodically probe third-party accounts. A rejected OAuth request can refresh and retry once, with concurrent refreshes coalesced. Rate limits remain quota state, while timeouts, network failures, server failures, and unclassified forbidden responses leave credential health unchanged. When an account needs intervention, Sidebar, Providers, Usage, and related Settings surfaces present only the fact that action is required without exposing credential contents or third-party account identifiers.

When credential health is `action_required`, stored provider credentials can be cleared through Disconnect. Disconnect removes the Synergy-managed stored credential entry but preserves the provider catalog, model catalog, and configuration; the provider remains visible and can be reconnected. Environment and plugin-supplied credentials are unaffected because they are not stored by Synergy and remain active.

MCP tools still pass through Synergy's tool exposure, capability, approval, timeout, and plugin-hook pipeline. See [Execution Boundaries](../architecture/execution-boundaries.md).

## Email

Email is an optional direct integration configured in `110-email.jsonc`. SMTP owns outgoing mail and IMAP owns mailbox search, summaries, full reads, and marking messages as seen. The send service pools at most two SMTP connections and closes an idle pool after one minute; transport errors discard the pool so the next call reconnects.

The `email_send` and `email_read` tools share the `communication.email` taxonomy. Reads are external I/O. Sending is both stateful and external, and it asks through a non-bypassable communication permission containing the recipient and subject. Email credentials remain config secrets; they are redacted from normal config responses and are not supplied by a Holos account or Channel provider.

## GitHub Integration

Synergy polls GitHub repositories outbound using GitHub App installation tokens. It requires no public inbound listener. Events are synthesized from REST API responses and processed through three independent pipelines: shadow-only diagnostic proposals, opt-in autonomous issue fix delivery, and opt-in automatic PR review and testing. All pipelines are disabled by default. Configuration is in `130-github.jsonc`.

The shadow pipeline classifies issues and CI failures, then optionally produces hidden Cortex structured proposals. It is read-only and never performs GitHub API writes.

The fix workflow, when enabled with `fixWorkflow.repositoryMapping`, inspects opened issues, locates root causes, posts a proposed-fix comment, implements and tests the fix in an isolated worktree, commits, pushes a branch with an ephemeral GitHub App installation token, opens a deduplicated pull request, and posts a completion comment. Agents never receive the token and cannot run `gh`, `git push`, or `git remote` operations.

The review workflow, when enabled with `reviewWorkflow.repositoryMapping`, fetches exact PR head and base SHAs, runs a read-only reviewer in an isolated worktree, executes configured verification commands, and publishes a pull request review comment and a check run.

GitHub App credentials (`SYNERGY_GITHUB_APP_ID`, `SYNERGY_GITHUB_APP_PRIVATE_KEY`) are environment variables only. See [GitHub Integration](../architecture/github-shadow.md) for the full polling architecture and processing pipeline.

When both credentials are present, the Sidebar shows a GitHub section between Background and Projects. It aggregates the durable sessions created by shadow proposals, issue location/fix work, and PR reviews across Home and project Scopes, including their silent Cortex child sessions. Credential values never cross the server boundary.

## Boundaries

- Channels translate external conversations and remote task assignments into canonical Synergy Sessions and managed Project Scopes.
- Holos supplies optional network identity, reachability, contacts, and direct agent messaging.
- Synergy Link performs typed remote session and process operations over Holos transport.
- MCP supplies callable external tools; providers supply models.
- Email supplies direct SMTP/IMAP operations; it is neither a Channel endpoint nor a Holos mailbox.
- GitHub integration supports shadow diagnostics plus opt-in autonomous fix delivery and PR review through outbound API polling, not a Channel endpoint or inbound webhook.
- Local projects, sessions, configuration, Library, Notes, and provider credentials continue to work without Holos.
