# Agents, Tools, Skills, and Commands

Synergy separates who performs work from the capabilities and reusable instructions available to that worker.

- an **agent** selects behavior, model preferences, permissions, and delegation policy
- a **tool** is a typed operation the model can invoke
- a **skill** is an on-demand workflow and supporting resources loaded into model context
- a **command** is a named prompt template invoked by a user or CLI flow

These objects can come from the runtime, configuration, a project, a plugin, MCP, or an external-agent adapter. Their sources merge into one resolved catalog, but they retain different execution boundaries.

## Agent Sources

Built-in agents provide the two primary orchestrators and specialist catalogs. User and project configuration can add or override agents through `60-agents.jsonc` or agent Markdown files. Plugins can contribute agents through the public plugin contract.

The built-in user-facing catalogs are:

- `synergy` — the classic general orchestrator, with `developer`, `explore`, `scout`, `advisor`, `inspector`, `scribe`, and `scholar`
- `synergy-max` — the expanded coding harness, with analysis/design specialists (`requirements-engineer`, `code-cartographer`, `dependency-tracer`, `solution-architect`, `api-contract-designer`, `migration-architect`); implementation/test specialists (`test-strategist`, `fixture-builder`, `property-test-engineer`, `type-test-engineer`, `implementation-engineer`, `refactoring-engineer`, `integration-engineer`, `documentation-engineer`); quality reviewers (`quality-gatekeeper`, `python-quality-engineer`, `rust-quality-engineer`, `typescript-quality-engineer`, `maintainability-reviewer`, `security-reviewer`, `performance-reviewer`, `api-compatibility-reviewer`, `documentation-reviewer`); documentation/research specialists (`docs-researcher`, `research-methodologist`, `research-scout`, `literature-searcher`, `literature-analyst`); and session-history support (`session-historian`)

`supervisor` and `lightloop-reviewer` are host-selected workflow reviewers rather than normal user-selected task targets. Their Cortex review tasks are visible in the execution session's Subagent Dock, while ordinary completion notifications remain suppressed because workflow approve or reject owns result delivery. Other hidden primary-role agents perform host-owned model work rather than user tasks: `multimodal-looker`, `compaction`, `chronicler`, `title`, `summary`, `intent`, `script`, `reward`, `smart-allow`, `agent-generator`, and `anima`. An agent marked hidden is selected by the runtime for a defined operation; that agent-catalog setting is independent from the visibility of any Cortex task it runs.

External agents are locally installed agent programs that Synergy discovers and presents through the same agent selector. Current adapters support:

- OpenAI Codex
- Claude Code
- OpenClaw

Discovery checks the binary, version, and per-adapter configuration. `disabled` and `auto_discover` control registration; `path`, `model`, and adapter-specific fields refine startup. Codex is exposed only when the `openai-codex` provider has authenticated the native Codex path.

An external agent remains inside a Synergy session. Synergy gives it the current prompt, discovered project instructions, and Cortex task context, then maps its text, reasoning, tool, usage, error, and approval events into canonical message parts. Cancellation stops the adapter turn, completed tool output is bounded, and the normal session-turn/plugin/experience completion path still runs.

The effective Synergy control profile is passed into the adapter. Claude Code uses its permission bypass only for `full_access`; ordinary modes use its default permission behavior. External-agent approval requests emitted during a turn are currently declined by the Synergy bridge, so the external process must finish within its configured noninteractive boundary rather than opening a second approval UI.

## Agent Catalogs and Delegation

An agent can be `primary`, `subagent`, or available in both modes. Visibility masks decide which orchestrator can see a subagent; delegation groups let controlled reviewers or orchestrators access an additional catalog. Hidden agents implement host-owned tasks such as compaction or workflow review and are not normal user-selected task targets.

Choosing an agent does not by itself authorize its operations. The resolved tool catalog and every invocation still pass through the active control profile and execution boundary. Delegated work uses a Cortex child session rather than running invisibly inside the parent's transcript.

## Tool Catalog and Exposure

Synergy assembles tools from built-ins, plugins, MCP servers, and turn-specific ephemeral sources. Exposure controls model-context cost and discovery:

- `resident` tools are present directly
- `group` tools load through a named capability group
- `search` tools are found with tool search
- `internal` tools are available only to an explicitly controlled host flow

Exposure is not permission. Tool taxonomy, effective arguments, Scope/workspace, protected paths, external effects, and active profile determine whether a call is allowed, denied, or can ask.

Tools return ordered message parts with text output, structured metadata, and optional attachments. Product UI renders those parts in transcript order; a custom or media presentation does not erase the durable tool call.

Current first-party families cover workspace read/write/search, shell and persistent processes, LSP and diagnostics, Web research, Browser interaction, attachments and media rendering, sessions and delegation, todo/DAG/workflow state, Agenda, Library, Notes, email, worktrees, and Synergy maintenance. Most large families are grouped or searchable rather than permanently occupying every model prompt.

## Todo and DAG State

A session can retain two forms of agent-authored working state. Todo is a linear checklist for immediate steps. DAG is a dependency graph whose nodes carry content, status, dependencies, assignment hints, memo, and optional Cortex task/session bindings. Agents can replace or read the graph and patch selected nodes without rewriting unrelated state; Cortex completion can update a bound node and make newly unblocked work eligible.

Todo and DAG are coordination aids inside one session. They are not durable workflow modes, do not continue an idle session by themselves, and do not replace a Lattice Pathway. Lattice owns an adaptive sequence of reviewed Blueprint executions; DAG describes dependencies among the tasks an active agent is coordinating.

## Questions

Questions are blocking decision requests associated with a session and optional tool call. Each request contains one or more short prompts, labeled options, an optional multi-select rule, creation time, and timeout. Web and protocol clients reply or reject through the shared question API.

The configured timeout can be disabled or changed. A timeout returns an explicit empty/timed-out result so the agent can continue with judgment; a dismissal rejects the tool call. Unattended sessions reject questions immediately because Agenda, Channel, and other autonomous work cannot wait on an interactive surface.

## Skills

A Skill contains `SKILL.md` plus optional scripts, references, and assets. Metadata controls discovery; the body is loaded only after the Skill is selected, and additional resources are loaded as needed. This progressive disclosure keeps specialized workflows out of every prompt.

Skills can be built in, global, project-local, plugin-provided, or imported from a local directory or URL. Skill roots are trusted runtime areas for operations that remain inside the configured root, but a Skill does not bypass tool permissions when it reads or writes elsewhere.

## Commands

Commands are reusable named prompt templates loaded from configuration and command Markdown files. A command can accept arguments and route the resulting prompt through the normal session/agent/Scope path. Plugin runtime hooks can also contribute plugin-owned CLI command families.

Commands are user entry points, not hidden tools: invoking one creates ordinary session work and retains normal history and control-profile semantics.

## Agent Client Protocol

`synergy acp` exposes Synergy as an Agent Client Protocol v1 agent over NDJSON stdio while hosting a local Synergy server for the connection. An ACP client can create or load a Synergy session, select advertised modes and models, prompt it, receive streaming text/reasoning and tool updates, and answer Synergy permission requests with allow-once or reject.

ACP session IDs are Synergy session IDs. Loading a session replays its visible user, assistant, tool, and plan history into the ACP client; new events continue through the same session event stream. MCP server descriptors supplied by the ACP client are retained in ACP session state. Authentication is advertised through `synergy auth login`; the ACP `authenticate` method itself is not implemented.

ACP is an inbound client protocol. External-agent adapters are the inverse boundary: Synergy invokes another local agent program. They should not be conflated.

## Configuration and Extension Boundaries

- [Configuration](../reference/configuration.md) defines agent, skill, command, model, and instruction discovery.
- [Cortex](../architecture/cortex.md) defines delegated child sessions.
- [Execution boundaries](../architecture/execution-boundaries.md) defines tool visibility versus execution.
- [Plugin documentation](../plugins/README.md) defines plugin-provided agents, tools, skills, commands, MCP, and UI.
