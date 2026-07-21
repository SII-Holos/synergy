# Connections

Synergy can connect to model and tool services through providers and MCP, messaging systems through Channels, mail servers through SMTP and IMAP, the Holos agent network, and remote Synergy hosts through Synergy Link. These boundaries serve different purposes and should not be conflated.

## Channels

Channels adapt an external messaging account into persistent Synergy sessions. A provider connects one or more configured accounts and normalizes each incoming message into a common context containing account, chat, sender, thread, mention, quote, and attachment information. It resolves the Synergy Scope separately and passes it explicitly to the Channel handler.

Synergy derives a stable endpoint key from the provider, account, chat, and optional Scope key. Messages for that endpoint reuse its unattended session instead of creating an unrelated conversation for every inbound message. Incoming commands are handled before ordinary agent invocation.

The provider contract supports:

- direct messages and groups
- replies and proactive pushes
- text, image, file, audio, and video parts
- reactions and delivery-status reactions
- streaming text and tool progress
- reconnect and account status

Feishu/Lark and Clarus are built-in providers. Feishu explicitly routes its current conversations to Home Scope. Clarus maps each remote project to a Project Scope through the common Channel project-scope API. Provider-specific wire formats, deduplication, and delivery stay behind the provider boundary while Channel owns Scope mapping, endpoint/session routing, and outbound delivery.

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

Synergy Link uses the same authenticated Holos tunnel as a transport for explicit remote-execution sessions. In the one-way A-controls-B model, A persists each remote host as a Link target with a stable local target ID, display name, target Holos agent ID, Link ID, enablement state, and optional local-agent allowlist. A does not copy or store B's Holos credentials; B remains responsible for approving, denying, or revoking access.

The Synergy Link Settings page creates and manages these targets. A successful connection or connection test records B's observed host session and capabilities, including platform, architecture, runtime, and shell support. These observations are metadata, not a guarantee of current reachability.

Agents use `connect list_targets` to discover only the enabled targets allowed for their agent name, then use the stable `targetID` for `connect`, `bash`, and `process` calls. Raw target agent and Link IDs remain available for legacy calls and manual diagnosis, but agents do not need them in the normal flow.

The protocol currently distinguishes:

- session lifecycle operations
- remote Bash execution
- remote process execution and process control

Bash and process calls require an active Link session ID. Every request carries a protocol version, request ID, Link ID, target agent, tool/action, and typed payload. Responses are correlated to the request, schema-validated, and normalized into typed remote or transport errors. A transport request times out after 30 seconds. Any supplied remote selector is classified through the non-bypassable remote-execution capability, and invalid, disconnected, or sessionless selectors fail closed instead of running the command locally.

Synergy Link does not make the remote filesystem part of the local Scope. It is an explicit execution boundary with its own session lifecycle, transport failures, and remote error semantics. When the Holos connection is disposed, pending requests fail and active local Link-session state is cleared.

## Clarus

Clarus uses the authenticated Holos Agent Tunnel through the Channel provider lifecycle. The provider discovers active projects, subscribes to project events, and maps each project to a standard Synergy Project Scope.

A project conversation is a normal Channel Session in that Scope. A task assignment creates or reuses an ordinary autonomous Session in the same Scope and stores only that `sessionID` in provider-private assignment state. Clarus does not add a second project registry, workspace manager, Session endpoint type, navigation hierarchy, composer, or timeline.

Clarus projects therefore appear in the standard Scope list, and their conversations and assignments use the standard Session page. Connection health is reported through the ordinary Channel account status.

## MCP and Model Providers

MCP connections add external tools and resources to the agent runtime; model providers supply language and embedding models. Both are configured independently of Holos and Channels. A Holos identity does not provide model billing or API credentials, and a Channel account is not a model provider.

Provider authentication health changes only in response to real model, usage, or model-discovery requests; Synergy does not periodically probe third-party accounts. A rejected OAuth request can refresh and retry once, with concurrent refreshes coalesced. Rate limits remain quota state, while timeouts, network failures, server failures, and unclassified forbidden responses leave credential health unchanged. When an account needs intervention, Sidebar, Providers, Usage, and related Settings surfaces present one shared recovery state appropriate to stored or environment-backed credentials.

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

- Channels translate external conversations into endpoint sessions.
- Holos supplies optional network identity, reachability, contacts, and direct agent messaging.
- Synergy Link performs typed remote session and process operations over Holos transport.
- MCP supplies callable external tools; providers supply models.
- Email supplies direct SMTP/IMAP operations; it is neither a Channel endpoint nor a Holos mailbox.
- GitHub integration supports shadow diagnostics plus opt-in autonomous fix delivery and PR review through outbound API polling, not a Channel endpoint or inbound webhook.
- Clarus uses the same Holos tunnel through the Channel provider lifecycle.
- Local projects, sessions, configuration, Library, Notes, and provider credentials continue to work without Holos.
