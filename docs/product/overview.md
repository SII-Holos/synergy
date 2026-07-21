# Synergy Product Overview

Synergy is an open-source AI agent workspace for persistent, recoverable software and knowledge work.

It provides one runtime for sessions, agents, tools, automation, knowledge, and integrations. Web, Desktop, and CLI are different clients of that runtime, so work can move between interactive, background, and one-off flows without creating separate product worlds.

Synergy can run on its own. Connecting to Holos adds account identity and networked capabilities, allowing for seamless work across agents around the world.

## Product Promise

Synergy is designed for work that lasts longer than one prompt.

- Work has an explicit context and can be resumed later.
- Sessions preserve the history and state of a task.
- Agents can use tools, delegate work, and continue in the background within explicit control boundaries.
- Knowledge can be retained as reusable memory, learned experience, or authored documents.
- Repeated work can be expressed as Blueprints or scheduled through Agenda.
- Humans and agents can operate on the same files, browser page, notes, and session state.

The result is a workbench for ongoing and long-horizon agent-assisted work rather than a disposable chat interface.

## Operating Model

The Synergy server is the center of the product. It owns persistent state and coordinates sessions, model providers, tools, permissions, integrations, background work, and product events.

Clients connect to the server and supply the context needed for the work they start:

| Surface    | Role                                                                                                                                                                                                        |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Web        | The primary interactive workbench for sessions, projects, notes, knowledge, automation, Browser, settings, and operational views.                                                                           |
| Desktop    | The production Electron client. It can manage a packaged local server and provides native desktop capabilities such as the embedded Browser presentation, folder selection, protocol handling, and updates. |
| CLI        | Starts and manages the runtime, opens clients, runs one-off `send` tasks, and exposes operational workflows.                                                                                                |
| Server API | The shared product boundary used by first-party clients, generated SDKs, and integrations.                                                                                                                  |

This client-server model lets one runtime serve more than one project and more than one client while keeping each task attached to an explicit workspace context.

## Core Product Objects

### Scope

A Scope identifies the context in which work happens. A Scope is either the user's home context or a selected project directory.

Scope determines which project configuration, instructions, files, knowledge, and runtime resources apply. Project selection is explicit: the selected directory is the project context rather than a hint to search upward for another root.

### Session

A session is a durable container for work. It records the conversation, tool activity, task state, model and agent choices, summaries, and relationships to delegated or forked work.

Within a session, user work is processed as ordered tasks. A task has one root user message, and the assistant messages produced for that task remain attached to that root. New input can start the next task, steer active work, or add context without creating a second in-memory mailbox model.

A session is therefore more than transcript storage: it is the unit users return to when they want to continue, inspect, fork, rewind, or review work.

### Compaction

Compaction lets a long-running session continue after its accumulated model context approaches the selected model's limit. Synergy writes a structured continuation summary anchored to the active task's root user message, then uses that summary as the boundary for later model calls. If model summarization fails, a mechanical fallback still establishes a recoverable boundary.

Compaction changes the context sent to the model; it does not delete the durable session history. Synergy can also prune large outputs from older completed tool calls while protecting recent turns and important tool context. The Web client replaces its loaded message view with the server's post-compaction state so the persisted history and visible timeline remain aligned.

### Agent

An agent defines how work should be performed. Its configuration can select prompts, models, tools, permissions, delegation capabilities, and specialized behavior.

Synergy includes primary orchestrators and specialist subagents. Primary agents coordinate the user's task; subagents perform bounded work in child sessions. Hidden reviewers can audit controlled workflows without becoming user-selectable primary agents.

Agents can also come from user/project configuration, plugins, or discovered external-agent adapters such as Codex, Claude Code, and OpenClaw. External programs still write into Synergy's durable session/message model rather than creating a parallel transcript.

### Tool

Tools let agents act on the workspace and connected systems. They include built-in capabilities, MCP tools, plugin-provided tools, and product operations such as notes, memory, tasks, and Browser control.

Tool availability and tool execution are separate decisions. Agent visibility determines which tools an agent can see, while enforcement, control profiles, permission decisions, and operating-system sandboxing determine whether and how an invocation can run.

## Knowledge and Authored Work

Synergy has two complementary knowledge surfaces: Library and Notes.

### Library

Library is the knowledge and memory subsystem. It stores two kinds of reusable knowledge:

- **Memory cards** are explicit pieces of knowledge organized by category and recall mode. Some are always included, some are retrieved contextually, and some are available only through search.
- **Experiences** are learned from completed session work. They preserve the intent, execution script, result signals, and retrieval feedback needed to improve future work in a similar Scope.

Library recall can provide relevant context to a session before model execution. Memory search can fall back to text matching when semantic embeddings are unavailable; experience retrieval remains scoped to the current work context.

### Notes

Notes are authored documents stored in a home or project Scope. They support rich content, tags, pinning, search, version-aware editing, archiving, and controlled deletion. Global notes can remain visible while working inside project scopes.

Notes do not become Library memories automatically. They are documents users and agents intentionally read and edit.

### Blueprints

A Blueprint is an executable kind of Note. In addition to document content, it can define the agent and workflow metadata needed to run a repeatable plan.

Blueprints connect planning with execution: users can refine a durable plan as a document, equip it in a session, and run it through a controlled loop while preserving run state and history. Their execution rules are stricter than those of ordinary notes so that an agent cannot silently turn general document editing into automation.

## Ways Work Runs

Synergy supports several execution patterns. They share sessions and control boundaries but serve different purposes.

### Interactive and one-off work

Users can work interactively from Web or Desktop, or submit a one-off task with `send`. Both paths use the same agents, tools, Scope model, and session infrastructure.

### Plan and Blueprint execution

Plan is a read-only planning workflow for producing or refining a decision-complete Blueprint. The agent may inspect code, documents, sessions, memory, and external sources; ask the user about blocking decisions; and use research or design subagents. It cannot implement the requested outcome, modify project files, deploy, or perform external identity actions while Plan is active.

A Blueprint is the durable handoff from planning to execution. Starting a user-owned BlueprintLoop exits Plan or Light Loop while the session is idle, binds the Blueprint to the session, and runs it until the execution agent requests review. An independent audit agent then approves the result or returns structured remaining work so execution can continue. Planning and execution therefore share one authored contract without collapsing into the same workflow phase.

### Light Loop

Light Loop is a focused persistence workflow for one task. When the session becomes idle, the continuation kernel asks the agent to compare the original task with the current work, continue anything incomplete, and gather evidence before requesting completion.

Calling `loop_stop` requests an independent review rather than ending the workflow immediately. Approval completes and clears the Light Loop; rejection returns concrete remaining instructions to the execution session and re-enables continuation. This keeps a lightweight task moving without requiring the user to design a multi-step plan first.

### Lattice

Lattice is the structured workflow for larger goals that need staged planning, execution, and validation. It turns the goal into an ordered Pathway, creates a Blueprint for the current step, executes that step through a Lattice-owned BlueprintLoop, analyzes the result, and advances to the next eligible step.

An `auto` run starts the current step's bound Blueprint as the session becomes idle. A `collaborative` run pauses at Blueprint review so the user can inspect or refine the step before continuing. Lattice tracks phases, step outcomes, model-call budget, events, and pause/resume state, and it can revise remaining Pathway steps without rewriting terminal history.

### Delegated work

An agent can delegate bounded tasks to specialist agents through Cortex. Each delegated task runs in a child session with an explicit parent-child link to the originating session, keeps its own context and history, and can continue in the background. It returns a summary, final response, or structured result to its parent. Re-delegation is available only where agent policy explicitly permits it.

### Agenda automation

Agenda stores persistent work items that run from time, file, or webhook triggers. Items can use a selected agent, model, control profile, session mode, timeout, and delivery behavior.

Recurring work can reuse a persistent session so context accumulates over time. One-shot work can use an ephemeral session and archive it after the result is delivered. Agenda prevents overlapping runs of the same item and pauses repeatedly failing items instead of retrying forever without intervention.

Unattended Agenda work uses autonomous control boundaries by default: it must finish within policy or fail with a clear denial rather than waiting for a user permission prompt.

## Connected Capabilities

### MCP

Model Context Protocol integrations add external tool ecosystems to the same agent and permission model as built-in tools. MCP configuration can be global or project-specific through Synergy's domain configuration system.

### Email

Optional SMTP and IMAP configuration lets agents send, search, summarize, read, and mark email through governed tools. Reading and sending share one communication capability family; sending is a non-bypassable external write with recipient and subject surfaced for approval. Email accounts and credentials are independent of Channels and Holos identity.

### Channels

Channels connect external messaging systems to Synergy sessions. Incoming messages are mapped to a persistent endpoint session, processed by an agent, and streamed back with replies and relevant progress. Account, direct-message, group, mention, attachment, and reconnect behavior belong to the channel provider.

Feishu/Lark is the current built-in channel provider. The channel boundary is designed so other messaging providers can implement the same session-oriented contract.

### Holos

Holos is an optional identity and agent-network layer. When connected, the selected Holos agent is the Synergy account identity. Its public profile is owned remotely, while local storage retains only the credentials and metadata needed to reconnect.

Synergy can create or import a Holos agent and switch between locally saved agent identities. Login state and network readiness remain separate: a saved identity can exist while its network connection is reconnecting or unavailable.

After authentication, Synergy opens a persistent WebSocket agent tunnel to Holos. The runtime keeps that tunnel alive with heartbeats and bounded reconnect attempts, tracks the reachability of peer agents, and maintains a user-managed local contact list with blocking controls. Agents can exchange direct messages through the tunnel. Message history is retained locally as inbox and outbox threads, while outgoing messages record delivery or failure state and can be retried after a connection problem.

The same tunnel provides the transport for Synergy Link. A connected Synergy instance can open an explicit Link session with a target Holos agent, manage that remote session's lifecycle, and route supported shell and process operations to the associated Synergy Link host. Link state is tied to the live Holos connection; disconnecting removes the remote execution client and clears its active Link sessions.

### Clarus

When Holos is connected, the Clarus Channel provider maps remote projects to standard Project Scopes. Project conversation uses a Channel Session and assignment work uses ordinary Sessions in the same Scope, so the existing Scope list, Session navigation, composer, history, and permissions remain the only product surface.

Holos does not replace local sessions, model providers, project configuration, Library, Channels, or their stored data. Only capabilities that explicitly use the Holos network depend on the connection.

### Plugins

Plugins extend Synergy with tools, agents, skills, commands, MCP servers, provider behavior, configuration, hooks, and product UI.

A plugin declares its contributions and requested permissions in a manifest. Synergy evaluates provenance, trust, risk, permission changes, and runtime isolation before enabling it. Install and update flows surface meaningful permission changes for consent, and higher-risk third-party code is isolated from the main runtime.

Plugins participate in the same product contracts as first-party features: tool execution remains governed, UI contributions use defined workbench surfaces, and extension state is visible to the runtime rather than loaded as an unbounded script.

## Browser Workspace

Browser is a session-owned workspace where humans and browser tools operate on the same page.

Each session has at most one Browser page. Reading Browser state or opening an interactive viewer does not create that page; the first user or tool navigation creates it, and later navigation reuses it.

Interactive presentation has two first-class modes:

- Desktop presents the page through a native Electron `WebContentsView`.
- Web presents a remote Browser host through WebRTC media and data-channel input.

Both modes preserve normal browser interaction such as pointer focus, text caret, IME composition, paste, wheel, and keyboard shortcuts. Navigation and file access pass safety checks, and agent-driven Browser actions remain subject to the active control profile.

## Control Boundaries

Synergy separates what an agent can discover from what it can execute.

- Agent and tool rules determine capability visibility.
- The enforcement gate classifies the requested operation.
- A control profile resolves the operation to allow, ask, or deny.
- SmartAllow can resolve eligible low-risk uncertainty using redacted evidence.
- Process tools can be contained by an operating-system sandbox when the decision requires it.

The standard profiles express three product modes:

| Profile       | Intended behavior                                                                                                                                          |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `guarded`     | Interactive work. Synergy can ask the user when a decision requires approval.                                                                              |
| `autonomous`  | Unattended work. Synergy must automatically allow or deny and never wait for a user prompt.                                                                |
| `full_access` | Author-at-own-risk execution. Capability checks are allowed silently, while ordinary validation, operating-system, test, and network failures still apply. |

These boundaries apply across direct tool calls, delegated tasks, Agenda, Browser automation, MCP, and plugins.

## Standalone and Connected Use

A standalone Synergy installation supports the complete local work model:

- projects and home Scope
- persistent sessions
- configurable agents and providers
- built-in, MCP, and plugin tools
- Library, Notes, Blueprints, and Agenda
- Web, Desktop, CLI, and Browser workflows

Connecting Holos adds a network identity and connected-agent capabilities. Provider credentials and model usage remain separate from Holos account identity: users configure model access through providers, whether or not Holos is connected.

## Product Principles

The following principles should remain true as individual features evolve:

1. **One runtime, several clients.** Product surfaces share sessions, state, and execution semantics.
2. **Durable by default.** Meaningful work can be resumed, inspected, and reused.
3. **Explicit context.** Scope, session lineage, and execution ownership remain visible and traceable.
4. **Shared work surfaces.** Humans and agents operate on the same canonical files, documents, Browser page, and task history.
5. **Bounded autonomy.** Interactive and unattended work use explicit, predictable control profiles.
6. **Distinct knowledge forms.** Memories, experiences, notes, and executable Blueprints keep separate responsibilities.
7. **Extensions follow product contracts.** Plugins and integrations participate in the same permissions, state, and UI model as built-in capabilities.

## Important Distinctions

- Runtime state is persistent even though the server is independent of any single project directory.
- Scope describes workspace context; session describes durable work within that context.
- Compaction replaces old model context with a continuation summary; it does not erase the session's durable history.
- A child session represents delegated work; an Agenda item represents triggered work; a Blueprint represents an executable authored plan.
- Plan produces a Blueprint; BlueprintLoop executes and audits it; Light Loop persists on one task; Lattice coordinates a Pathway of Blueprint-backed steps.
- Library stores reusable memory and experience; Notes store authored documents.
- Channels adapt external messaging into sessions; Holos provides optional identity and agent-network connectivity.
- Clarus uses the existing Holos agent tunnel through Channel; it does not add a separate runtime, transport, navigation model, or Session type.
- Browser is a session workspace with one shared page, not a separate tab or screenshot-stream automation system.

For implementation-level invariants, continue with the [architecture documentation](../architecture/README.md). For durable Web interaction and visual rules, see the [Web product contract](../../packages/app/PRODUCT.md). Plugin authors should begin with the [plugin documentation](../plugins/README.md).
