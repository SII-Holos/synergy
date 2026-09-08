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

| Document                                         | Contract                                                                                                                        |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| [Runtime and Scope](runtime-and-scope.md)        | Server lifecycle, global and project runtimes, Scope resolution, workspace binding, and request context.                        |
| [Workspace and files](workspace-and-files.md)    | Worktrees, workspace-file routes, file search/read, anchored editing, formatting, diagnostics, snapshots, and restore.          |
| [Sessions and messages](session-and-messages.md) | Durable session state, canonical message semantics, task roots, inbox modes, history, fork, and recovery.                       |
| [LLM loop and compaction](llm-loop.md)           | Single-writer loop, prompt assembly, model execution, tools, loop jobs, compaction, and terminal behavior.                      |
| [Frontend data sync](frontend-data-sync.md)      | Scope event sequencing, replay, delta/checkpoint streaming, reconcile writes, compaction swaps, and eviction.                   |
| [Frontend localization](localization.md)         | Global locale ownership, catalog activation, message IDs, formatting, translation boundaries, and verification.                 |
| [Channels](channels.md)                          | Channel targets, provider lifecycle, managed Project ownership, task routing, borrowed transports, diagnostics, and projection. |
| [Execution boundaries](execution-boundaries.md)  | Tool visibility, capability classification, control profiles, permissions, SmartAllow, and OS sandboxing.                       |
| [Cortex and delegated work](cortex.md)           | Child sessions, task lifecycle, concurrency, output contracts, background work, and parent delivery.                            |
| [Workflow engine](workflows.md)                  | Continuation kernel, Plan, BlueprintLoop, Light Loop, Lattice, review, and recovery.                                            |
| [Browser runtime](browser-runtime.md)            | Page ownership, control, native/WebRTC presentation, navigation policy, input, and lifecycle.                                   |
| [GitHub Channel](github-channel.md)              | GitHub as a Channel: polling, event gating, per-thread checkouts, agentic review/QA/fix sessions, and comment delivery.         |
| [Push notifications](push.md)                    | Web Push delivery: event bridge, per-subscription categories, VAPID keys, routes, service-worker contract, and iOS PWA limits.  |

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

### Workspace packages

Workspace membership and dependency versions come from the root and package `package.json` files. `bun run deps:check` verifies declared imports, public exports, package cycles, and the allowed dependency directions in `script/dependency-rules.json`. The release catalog identifies distributable entries; it does not duplicate dependencies.

| Owner                                                                     | Responsibility                                                                                                                             |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/harness`                                                        | Session execution, Scope, generic tool scheduling and enforcement, budgets, cancellation, recovery, rollout evidence and runtime lifecycle |
| `packages/runtime-local`                                                  | Default model SDK factories, local tools, native PTY/watchers/OS sandboxes, workspace/Git integration and registration                     |
| `packages/cli`                                                            | The single `synergy` parser, command execution, local client and remote SDK client                                                         |
| `packages/server`                                                         | HTTP/WS transport, core routes and explicit route contributions                                                                            |
| `packages/product-runtime`                                                | Full configuration, tools, agents, services, routes and CLI composition; packaged product entry                                            |
| `packages/browser-runtime`, `packages/computer-runtime`                   | Browser and Computer backend capabilities, tools, ownership, recovery and host connections                                                 |
| `packages/library`, `packages/note`                                       | Knowledge processing and retrieval; documents and note operations                                                                          |
| `packages/workflows`                                                      | Blueprint, Light Loop, Lattice, Agenda and Boss                                                                                            |
| `packages/connections`                                                    | Email, Channels, Holos and GitHub integration                                                                                              |
| `packages/workbench`                                                      | Product Projects, statistics, notifications and read models                                                                                |
| `packages/agent-integrations`                                             | MCP, LSP, formatting, ACP, external agents and Link client                                                                                 |
| `packages/media`                                                          | Document extraction, voice and image operations                                                                                            |
| `packages/plugin-host`                                                    | Plugin discovery, process execution, trust and registered Host Services                                                                    |
| `packages/browser`, `packages/computer`, `packages/synergy-link-protocol` | Shared schemas and host protocols                                                                                                          |
| `packages/synergy-link`                                                   | Independently distributed Link host and CLI                                                                                                |
| `packages/plugin`, `packages/plugin-kit`                                  | Plugin author API, theme contracts and development tools                                                                                   |
| `packages/sdk/js`, `packages/ui`, `packages/util`                         | HTTP SDK, shared UI and product-independent utilities                                                                                      |
| `packages/testing`                                                        | Development-only isolation and test orchestration                                                                                          |
| `apps/web`, `apps/desktop`                                                | Web UI; Desktop UI, Electron and native Browser/Computer hosting                                                                           |

Business packages own their backend, tools, routes, configuration, storage upgrades and CLI contributions together. Within a package, folders represent business domains; small domains can use individual files. The CLI owns common parsing and output. A domain command delegates to the same service used by its routes and tools.

### Composition and public imports

Harness is callable without CLI, Server or optional product capabilities. Its `RuntimeHandle` owns admission, cancellation, draining, evidence flushing, worker cleanup and failed-start recovery. `runtime-local` registers the default host sources. `product-runtime` selects the complete capability set before opening the runtime. Each process owns one runtime and one home lock.

Public package exports are the cross-package resolution authority. Source development resolves these entries to the owning source files; package builds resolve the same entries to one corresponding compiled module. Private relative imports across workspace packages are rejected. Optional capabilities register through the existing registries and typed sources rather than automatic package discovery.

The CLI exposes an injectable runtime factory and command contributions. Its standalone entry uses the local runtime; the product entry uses full product composition. Both execute the same commands named `synergy`. Local requests call the runtime directly, while remote requests use the HTTP SDK. Browser Host remains a second Desktop entry with an independent artifact and lightweight protocol dependencies.

Detailed lifecycle, configuration, persistence, Browser presentation and session semantics remain in their owning documents above.

## Related Contracts

- [Product overview](../product/overview.md) defines user-facing objects and boundaries.
- [Web product contract](../../apps/web/PRODUCT.md) defines durable interaction and visual principles.
- [Reference documentation](../README.md#reference) owns commands, configuration, paths, packages, and development procedures.
- Root and package `AGENTS.md` files contain change rules and link back to these architecture contracts.

Native application automation is described in [Native Computer Use](computer-use.md).

## Harness public entry points

The programmatic entry points are `@ericsanchezok/synergy-harness/session`, `/scope`, `/tools`, `/context`, `/lifecycle`, `/config`, `/persistence`, and `/rollout`. They expose execution operations, schemas and explicit host contribution contracts. Additional leaf exports are declared individually for host implementations and domain composition; there is no source wildcard export.

`ToolInvocation.invoke` owns processor setup, permission checks, cancellation and execution evidence. Hosts do not construct partial processors. Every invocation enters global tool admission and scheduling. An active plugin parent identified by the same session, assistant message and call ID can lend one scheduling slot to a nested invocation; siblings remain serialized and other executor limits still apply. Parent termination cancels its unfinished children. `readRuntimeStats` and `readRolloutRevision` expose read-only views; the processor, tool resolver, scheduler and rollout journal are internal. White-box integration fixtures use explicit `test/` exports, which are removed from published tarballs and forbidden in production imports.

File browsing, indexing, Ripgrep, Hashline editing and conflict resolution belong to Runtime Local. Harness retains session read evidence and execution locking. Imports within Harness resolve relative to their owner module, so public entry points cannot create a second core instance or become internal dependency hubs.
