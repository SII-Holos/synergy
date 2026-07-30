# Synergy Architecture

These documents define the current implementation invariants of the Synergy runtime. They describe supported behavior directly; design exploration, issue history, and retired schemas belong in research or migration documents.

Code is authoritative. When code changes one of these contracts, update the owning document in the same change.

## System Shape

Synergy is a client-server system built around a persistent runtime:

1. The global runtime owns installation-wide services such as plugins, Channels, Holos, MCP, Agenda, recovery, and marketplace state.
2. A `Scope` selects home or project context for each request and session.
3. A lazily started project `ScopeRuntime` owns project-sensitive services such as file watching, LSP, formatting, VCS, and command state.
4. A durable session owns messages, inbox state, session-local workflow state, workspace binding, and at most one active LLM loop.
5. The LLM loop resolves agent, model, context, tools, execution policy, and persistence for one root task at a time.
6. The event system projects state changes to Web and Desktop clients, which reconcile them into scope-local stores.

Web, Desktop, CLI, Channels, Agenda, Cortex, and plugins all enter this same runtime model. They do not own parallel session or permission semantics.

## Core Documents

| Document                                         | Contract                                                                                                                             |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| [Runtime and Scope](runtime-and-scope.md)        | Server lifecycle, global and project runtimes, Scope resolution, workspace binding, and request context.                             |
| [Workspace and files](workspace-and-files.md)    | Worktrees, workspace-file routes, file search/read, anchored editing, formatting, diagnostics, snapshots, and restore.               |
| [Sessions and messages](session-and-messages.md) | Durable session state, canonical message semantics, task roots, inbox modes, history, fork, and recovery.                            |
| [LLM loop and compaction](llm-loop.md)           | Single-writer loop, prompt assembly, model execution, tools, loop jobs, compaction, and terminal behavior.                           |
| [Frontend data sync](frontend-data-sync.md)      | Scope event sequencing, replay, delta/checkpoint streaming, reconcile writes, compaction swaps, and eviction.                        |
| [Frontend localization](localization.md)         | Global locale ownership, catalog activation, message IDs, formatting, translation boundaries, and verification.                      |
| [Channels](channels.md)                          | Channel targets, provider lifecycle, managed Project ownership, task routing, borrowed transports, diagnostics, and projection.      |
| [Execution boundaries](execution-boundaries.md)  | Tool visibility, capability classification, control profiles, permissions, SmartAllow, and OS sandboxing.                            |
| [Cortex and delegated work](cortex.md)           | Child sessions, task lifecycle, concurrency, output contracts, background work, and parent delivery.                                 |
| [Workflow engine](workflows.md)                  | Continuation kernel, Plan, BlueprintLoop, Light Loop, Lattice, review, and recovery.                                                 |
| [Browser runtime](browser-runtime.md)            | Page ownership, control, native/WebRTC presentation, navigation policy, input, and lifecycle.                                        |
| [GitHub integration](github-shadow.md)           | Webhook receipt, L0 gate, L1 sessionless classification, L2 shadow proposals, autonomous fix delivery, and automatic PR review/test. |

## Cross-Cutting Invariants

- The server is independent of any single project directory, but its state is persistent.
- Every scoped operation runs inside `ScopeContext`; session execution also carries an explicit workspace.
- One session has at most one active LLM loop and one writer to its loop-scoped message cache.
- One root user message owns a task. Injected messages and assistant messages retain that root through `rootID`.
- Message scheduling, rendering, model inclusion, and provenance are orthogonal fields.
- All session delivery uses the persistent inbox and one `mode`: `task`, `steer`, or `context`.
- Tool discovery and tool execution are separate. Every executable tool call crosses the centralized enforcement and permission boundary.
- State events are sequenced per Scope runtime; streaming part deltas are deliberately unsequenced and converge through checkpoints.
- Frontend updates reconcile changed leaves instead of replacing whole store objects.
- Product extensions use the same session, event, permission, and workbench contracts as built-in features.
- Channel core owns Scope and Session integration; task-only providers report remote facts through `ChannelHost` and do not maintain parallel Project or Session models.
- Persisted schema upgrades run through domain migrations and the central migration runner.

## Ownership Map

| Area                     | Primary implementation                                                                     |
| ------------------------ | ------------------------------------------------------------------------------------------ |
| Runtime and server       | `packages/synergy/src/server/`, `daemon/`, `global/`                                       |
| Scope and workspace      | `packages/synergy/src/scope/`, `session/types.ts`, worktree tools                          |
| Files and coding harness | `packages/synergy/src/workspace-file/`, `file/`, `hashline/`, anchored file tools          |
| Sessions and messages    | `packages/synergy/src/session/`, `storage/`                                                |
| Agents and tools         | `packages/synergy/src/agent/`, `tool/`, `mcp/`                                             |
| Execution policy         | `packages/synergy/src/enforcement/`, `control-profile/`, `permission/`, `sandbox/`         |
| Delegation               | `packages/synergy/src/cortex/`                                                             |
| Workflow loops           | `packages/synergy/src/blueprint/`, `lattice/`, `session/*continuation*`                    |
| Knowledge                | `packages/synergy/src/library/`, `note/`                                                   |
| Activity statistics      | `packages/synergy/src/stats/`, server Stats routes, Web Stats components                   |
| Automation               | `packages/synergy/src/agenda/`                                                             |
| Channels                 | `packages/synergy/src/channel/`, Channel server routes, and Web Channel account projection |
| Other connections        | `packages/synergy/src/email/`, `holos/`, `synergy-link/`, `remote/`, `mcp/`, `github/`     |
| External agents and ACP  | `packages/synergy/src/external-agent/`, `acp/`                                             |
| Browser                  | `packages/synergy/src/browser/`, `packages/desktop`, Browser UI modules                    |
| Frontend sync            | `packages/app/src/context/`, `packages/synergy/src/bus/`, server event routes              |
| Plugins                  | `packages/synergy/src/plugin/`, `packages/plugin`, `packages/plugin-kit`                   |
| Observability            | `packages/synergy/src/observability/`, `performance/`, diagnostics and trace UI            |

## Related Contracts

- [Product overview](../product/overview.md) defines user-facing objects and boundaries.
- [Web product contract](../../packages/app/PRODUCT.md) defines durable interaction and visual principles.
- [Reference documentation](../README.md#reference) owns commands, configuration, paths, packages, and development procedures.
- Root and package `AGENTS.md` files contain change rules and link back to these architecture contracts.
