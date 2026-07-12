# Workspaces and Sessions

Synergy organizes work through four nested concepts:

1. the runtime hosts shared services and persistent state
2. a Scope selects home or project context
3. a session preserves one durable stream of work in that context
4. each root user message starts one ordered task inside the session

Clients, agents, automation, and integrations all use this model.

## Runtime and Clients

The server is the product runtime. It owns sessions, providers, agents, tools, configuration, permissions, knowledge, automation, integrations, and state events. It persists across client connections and is not permanently attached to one project directory.

Web and Desktop are interactive clients. The CLI starts, stops, discovers, and attaches to runtimes, opens Web, and submits one-off `send` work. Channels and Agenda create unattended work through the same session APIs. Closing a client does not redefine the server's current project or erase work.

## Scope

A Scope identifies where an operation belongs. The home Scope represents installation-wide personal context. A project Scope represents one explicitly selected directory.

Synergy does not search upward from the selected directory for a “real” project root. The exact selection determines project configuration, instructions, files, project Notes, file watching, formatting, LSP, VCS state, commands, and other project-sensitive services.

The global runtime serves every Scope. Project services start lazily when the Scope is first used and are disposed independently. Global configuration is merged with the selected project's domain configuration for scoped requests.

## Workspace Binding

A session belongs to a Scope and can also carry a workspace binding. The normal workspace is the Scope directory. A code task can instead enter an existing worktree or create a dedicated worktree while retaining the original Scope identity.

This distinction lets configuration and project ownership remain stable while execution files move to an isolated checkout. Worktree sessions can inspect ordinary files from the original checkout, but writes and command execution outside the active worktree remain protected unless explicitly authorized.

The Web workspace browses, previews, and searches files through Scope-contained APIs. Agents use governed file tools; the anchored coding harness can require a current file tag and proof that the edited lines were actually displayed. Formatting, LSP diagnostics, file events, snapshots, and runtime reload checks run around file changes without creating a second write boundary. See [Workspace and file operations](../architecture/workspace-and-files.md).

## Sessions

A session is the durable unit users navigate, resume, archive, fork, export, and inspect. It stores:

- title, Scope, workspace, timestamps, and archive state
- messages and message parts
- selected agent and model defaults
- control profile and interaction mode
- inbox, progress, summaries, and completion notices
- workflow, BlueprintLoop, Agenda, Channel, and Cortex metadata when applicable
- parent lineage and independent fork provenance

Only one LLM loop writes a session at a time. New reply-requiring work waits as the next task; steering input can influence the active task; context input can join model context without demanding another reply.

## Tasks and Messages

One root user message defines one task. Every assistant message generated for that task points back to the same root. This stable grouping is independent of visual rendering or model inclusion.

Messages describe four separate questions:

- `rootID` / `isRoot` — which task owns this message?
- `visible` — should the frontend render it?
- `includeInContext` — should the model receive it?
- `origin` — which product or runtime source created it?

Message parts separately identify whether their content originates from the user or system. These fields prevent generated control messages, hidden context, rendering, and scheduling from being collapsed into ambiguous booleans.

## Inbox Modes

All delivery into a session uses one persistent inbox:

- `task` starts the next root task and requires a reply
- `steer` changes the direction of currently running work
- `context` contributes information without starting another task

The inbox survives process boundaries. There is no second in-memory mailbox with different semantics.

## Agents and Tools

An agent selects prompt behavior, model preference, visible tools, control profile, and delegation policy. Primary agents coordinate user work. Subagents run bounded delegated tasks. Hidden agents implement internal review contracts without appearing in primary-agent selectors.

Tool discovery combines built-in tools, plugin tools, MCP tools, and turn-specific ephemeral tools. Visibility determines what the model can call; execution policy separately determines whether a particular invocation is allowed, denied, or requires interactive approval.

Configured and plugin agents share the native model loop. Discovered external agents run through local adapters and map their streaming/tool activity back into the same durable message model. Synergy can also present its own sessions to other clients through Agent Client Protocol. See [Agents, tools, skills, and commands](agents-and-tools.md).

## Delegation, Parentage, and Forks

Cortex delegation creates a child session under the parent. The child keeps its own history and returns an explicit summary, final response, or structured result. Parentage represents an execution hierarchy.

Forking creates a new session from an earlier point in history. `forkedFrom` records that provenance independently of `parentID`; a fork is not automatically delegated work, and a delegated child is not a history fork.

See [Cortex delegation](../architecture/cortex.md) for task lifecycle and output contracts.

## History, Rewind, and Recovery

Session history is durable and append-oriented. Undo and rewind are represented by history events that project a different effective view instead of destructively rewriting canonical messages. File restoration is an explicit operation associated with the selected point; changing the visible message timeline alone does not silently modify workspace files.

Archived sessions remain stored and can be restored. Deletion removes the session record and associated runtime resources through the session lifecycle. Startup recovery detects interrupted sessions, incomplete loop state, pending invocations, and stale runtime artifacts so an unclean process exit does not leave invisible active work.

## Compaction

Compaction replaces older model context with a structured continuation summary when the active model approaches its context limit. The summary is anchored to the task root, and later context begins from that boundary. Older tool outputs can also be pruned from model input according to size and recency rules.

The durable message history remains available. Compaction is a model-context operation, not deletion or archival. See [LLM loop and compaction](../architecture/llm-loop.md).

## Browser Ownership

The default Browser owner is the session. A session has at most one page, and both the user surface and Browser tools operate on that page. The Browser therefore behaves like a workspace alongside files and Notes, not like an unrelated browser application with its own task history.

See [Browser workspace](browser.md).

## Invariants

- The server owns runtime state; clients select context for each operation.
- Scope is explicit and uses the selected directory without upward project discovery.
- A session is durable and has one active writer.
- One root message owns one task and remains the parent anchor for its assistant messages.
- Scheduling, visibility, model inclusion, and provenance are independent semantics.
- Delegation hierarchy and fork provenance are different relationships.
- Compaction changes model context without erasing durable history.
