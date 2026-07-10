---
name: architecture
description: "Synergy codebase architecture guide. Use when navigating the codebase, understanding module boundaries, finding where functionality lives, or planning cross-cutting changes. Triggers: 'architecture', 'codebase structure', 'where is', 'how does X work', 'module layout', 'find the code for'."
---

# Synergy Architecture Guide

## Runtime Model

Synergy is a **client-server** system:

- **Server** (`packages/synergy`) — the core runtime, always running
- **Clients** — Web UI (`packages/app`), CLI (`synergy send`), desktop shell (`packages/desktop`), external via SDK

Clients connect to the server and provide a working directory (scope). The server handles sessions, agents, tools, and all orchestration.

## Package Map

| Package                          | Role                                                                   |
| -------------------------------- | ---------------------------------------------------------------------- |
| `packages/synergy`               | Core runtime: server, CLI, agents, tools, sessions, config, everything |
| `packages/app`                   | SolidJS web client                                                     |
| `packages/desktop`               | Electron desktop app, managed server host, signing, updates            |
| `packages/plugin`                | Plugin SDK (`@ericsanchezok/synergy-plugin`)                           |
| `packages/plugin-kit`            | Plugin development CLI (`@ericsanchezok/synergy-plugin-kit`)           |
| `packages/sdk/js`                | TypeScript SDK (`@ericsanchezok/synergy-sdk`)                          |
| `packages/ui`                    | Shared UI component library                                            |
| `packages/util`                  | Shared utilities and error helpers                                     |
| `packages/script`                | Build and release tooling                                              |
| `packages/synergy-link`          | Synergy Link remote collaboration                                      |
| `packages/synergy-link-protocol` | Link protocol definitions                                              |
| `packages/config-ui`             | Config UI                                                              |
| `packages/meta-protocol`         | Meta protocol                                                          |
| `packages/meta-synergy`          | Meta Synergy                                                           |

## Core Domains (`packages/synergy/src/`)

### Request Flow

`cli/` or `server/` → `session/manager.ts` → `cortex/` (task orchestration) → `session/tool-resolver.ts` → `tool/`

The flow is more nuanced than a simple pipe. The cortex layer manages DAGs, subagent delegation, and task loops between session and tool execution.

### Key Domains (58 directories)

| Directory          | What it does                                     | When you'd touch it                     |
| ------------------ | ------------------------------------------------ | --------------------------------------- |
| `access/`          | Access control                                   | Permission gating, authorization        |
| `acp/`             | Anthropic Client Protocol                        | ACP server/client integration           |
| `agenda/`          | Scheduled tasks and automation                   | Cron, triggers, background jobs         |
| `agent/`           | Agent definitions and prompts                    | Adding/modifying agents                 |
| `agora/`           | Agora feature                                    | Community features                      |
| `asset/`           | Asset management                                 | File assets, uploads                    |
| `attachment/`      | Attachment handling                              | File attachments in messages            |
| `blueprint/`       | BlueprintLoop audit system                       | Blueprint execution, review             |
| `browser/`         | Built-in Browser workspace                       | Browser automation, workspace           |
| `bus/`             | Event system                                     | Adding new system events                |
| `channel/`         | External messaging (Feishu, etc.)                | Adding new channel types                |
| `cli/`             | CLI commands and startup                         | New commands, CLI UX                    |
| `command/`         | Custom command system                            | Built-in and user-defined commands      |
| `config/`          | Config loading and merging                       | Config schema changes                   |
| `conflict/`        | Conflict resolution                              | Merge conflicts, edits                  |
| `control-profile/` | Permission/sandbox profile compiler              | Profile resolution, sandbox config      |
| `cortex/`          | Task orchestration (DAGs, subagents)             | Delegation and parallel execution       |
| `daemon/`          | Daemon process management                        | Background server, lifecycle            |
| `email/`           | Email integration                                | Sending/receiving emails                |
| `enforcement/`     | Capability classification and tool boundary gate | Centralized tool permission enforcement |
| `external-agent/`  | External agent integration                       | External agent discovery, bridge        |
| `file/`            | File system operations, watchers                 | File watching, format detection         |
| `flag/`            | Feature flags                                    | Conditional features                    |
| `global/`          | Global paths, installation, updates              | Root paths (`~/.synergy/`), version     |
| `hashline/`        | Hashline feature                                 | Comment hash lines                      |
| `holos/`           | Holos identity flow                              | Holos contacts, mailbox                 |
| `id/`              | Identifier system                                | ID generation                           |
| `lattice/`         | Lattice workflow system                          | Lattice execution                       |
| `library/`         | Memory/knowledge (embedding, recall)             | Memory features                         |
| `lsp/`             | Language Server Protocol integration             | LSP clients, diagnostics                |
| `mcp/`             | Model Context Protocol integration               | MCP server/client features              |
| `migration/`       | Central migration runner                         | Persistence upgrades, data migration    |
| `note/`            | Notes system                                     | Note CRUD, editing                      |
| `observability/`   | Observability and tracing                        | Event traces, diagnostics               |
| `performance/`     | Performance monitoring                           | Performance writer, metrics             |
| `permission/`      | Permission model                                 | Access control rules                    |
| `plugin/`          | Plugin system                                    | Plugin loading, registration            |
| `plugin-runtime/`  | Dynamic plugin runtime                           | Worker/process plugin execution         |
| `process/`         | Process management                               | Shell execution, PTY                    |
| `project/`         | Project config, worktree, VCS                    | Project-level settings, git             |
| `provider/`        | LLM provider integration                         | Adding providers, model resolution      |
| `question/`        | Question/ask system                              | Interactive questions                   |
| `remote/`          | Remote execution                                 | Remote tool execution                   |
| `runtime/`         | Runtime orchestration                            | Server lifecycle                        |
| `sandbox/`         | OS sandbox backend wrappers                      | Process sandboxing                      |
| `scope/`           | Workspace/project scope resolution               | Scope and context logic                 |
| `server/`          | HTTP server, API routes                          | New endpoints, CORS                     |
| `session/`         | Session lifecycle, prompting, recall             | Session features                        |
| `set-up/`          | Setup flow                                       | First-run setup                         |
| `skill/`           | Skill loading and built-ins                      | Skill system                            |
| `stats/`           | Usage statistics                                 | Stats collection                        |
| `storage/`         | File-based JSON persistence                      | All session/message/permission data     |
| `superplan/`       | SuperPlan eventing                               | SuperPlan workflow                      |
| `tool/`            | All tool implementations                         | Adding/modifying tools                  |
| `util/`            | Utilities                                        | Log, path, error helpers                |
| `vector/`          | Vector storage                                   | Embedding storage                       |
| `workspace/`       | Workspace management                             | Workspace sessions, discovery           |
| `workspace-file/`  | Workspace file operations                        | File workspace tools                    |

### Cross-cutting Concerns

- **Config** touches everything — changes ripple through CLI, server, agents
- **ScopedState** — `ScopedState.create()` in `scope/scoped-state.ts` is the scoped singleton pattern (wraps `State.create()` with scope-keyed isolation)
- **Bus events** — `BusEvent.define()` in `bus/bus-event.ts` + `Bus.subscribe()` in `bus/index.ts` for loose coupling. Used 82+ times across the codebase
- **Migrations** — schema changes go in `*/migration.ts`, run by `migration/index.ts`

## Common Patterns

- **Namespace exports**: `export namespace Foo { ... }` — the dominant pattern, used in 30+ files
- **Zod schemas**: all validation, all API types. Import `z` from `"zod"`
- **ScopedState**: `ScopedState.create(init, dispose)` for scope-keyed singletons (in `scope/scoped-state.ts`)
- **Bus events**: `BusEvent.define({ name, schema })` + `Bus.subscribe(Event, callback)` for event-driven communication
- **NamedError**: `NamedError.create()` for typed, structured errors (in `util/named-error.ts`) — used in provider, session, config, storage, etc. but NOT in tool files (tools use `throw new Error(...)`)

## Testing

### Quality verification

```bash
bun run quality:quick      # format:check + lint + typecheck + monorepo:check + package:check
bun run quality            # quality:quick + all tests (turbo test)
cd packages/synergy
bun test                   # all tests
bun test test/tool/read.test.ts  # specific test
bun test --watch           # watch mode
```

See [docs/open-source-quality.md](../../docs/open-source-quality.md) for the full quality model.

Tests live in `packages/synergy/test/` mirroring the `src/` structure. Shared fixtures in `test/fixture/`.

### Test philosophy

- **Test invariants, not implementations** — behavioral contracts that survive refactoring
- **Write tests first** (TDD) for new behavior and bug fixes
- **Avoid source text assertions** — call the function, check the result
- **Minimal mocking** — use temp directories (`tmpdir()`) + context overrides instead of mock frameworks
