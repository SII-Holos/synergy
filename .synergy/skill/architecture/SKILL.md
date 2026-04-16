---
name: architecture
description: "Synergy codebase architecture guide. Use when navigating the codebase, understanding module boundaries, finding where functionality lives, or planning cross-cutting changes. Triggers: 'architecture', 'codebase structure', 'where is', 'how does X work', 'module layout', 'find the code for'."
---

# Synergy Architecture Guide

## Runtime Model

Synergy is a **client-server** system:

- **Server** (`packages/synergy`) — the core runtime, always running
- **Clients** — Web UI (`packages/app`), CLI (`synergy send`), external via SDK

Clients connect to the server and provide a working directory (scope). The server handles sessions, agents, tools, and all orchestration.

## Package Map

| Package              | Role                                                                   |
| -------------------- | ---------------------------------------------------------------------- |
| `packages/synergy`   | Core runtime: server, CLI, agents, tools, sessions, config, everything |
| `packages/app`       | SolidJS web client                                                     |
| `packages/config-ui` | Configuration UI components                                            |
| `packages/plugin`    | Plugin SDK for extensions                                              |
| `packages/sdk/js`    | Generated TypeScript SDK                                               |
| `packages/ui`        | Shared UI component library                                            |
| `packages/util`      | Shared utilities and error helpers                                     |
| `packages/script`    | Build and release tooling                                              |

## Core Domains (`packages/synergy/src/`)

### Request Flow

`cli/` or `server/` → `session/` → `agent/` → `tool/`

### Key domains

| Directory     | What it does                         | When you'd touch it               |
| ------------- | ------------------------------------ | --------------------------------- |
| `agent/`      | Agent definitions and prompts        | Adding/modifying agents           |
| `agenda/`     | Scheduled tasks and automation       | Cron, triggers, background jobs   |
| `bus/`        | Event system                         | Adding new system events          |
| `channel/`    | External messaging (Feishu, etc.)    | Adding new channel types          |
| `cli/`        | CLI commands and startup             | New commands, CLI UX              |
| `config/`     | Config loading and merging           | Config schema changes             |
| `cortex/`     | Task orchestration (DAGs, subagents) | Delegation and parallel execution |
| `engram/`     | Memory/knowledge (embedding, recall) | Memory features                   |
| `mcp/`        | Model Context Protocol integration   | MCP server/client features        |
| `note/`       | Notes system                         | Note features                     |
| `permission/` | Permission model                     | Access control                    |
| `process/`    | Process management                   | Shell execution, PTY              |
| `provider/`   | LLM provider integration             | Adding providers                  |
| `scope/`      | Workspace/project scope resolution   | Scope and context logic           |
| `server/`     | HTTP server, API routes              | New endpoints, CORS               |
| `session/`    | Session lifecycle, prompting         | Session features                  |
| `skill/`      | Skill loading and built-ins          | Skill system                      |
| `tool/`       | All tool implementations             | Adding/modifying tools            |

### Cross-cutting concerns

- **Config** touches everything — changes ripple through CLI, server, agents
- **Scope/Instance** — most domain code runs within an Instance context
- **Bus events** — domains communicate through the event bus, not direct imports
- **Migrations** — schema changes go in `*/migration.ts`, run by `migration/`

## Testing

```bash
cd packages/synergy
bun test                          # all tests
bun test test/tool/read.test.ts   # specific test
bun test --watch                  # watch mode
```

Tests live in `packages/synergy/test/` mirroring the `src/` structure.

## Common Patterns

- **Namespace exports**: `export namespace Foo { ... }` — the dominant pattern
- **Zod schemas**: all validation, all API types
- **Instance state**: `Instance.state()` for scoped singletons
- **Bus events**: `BusEvent.define()` + `Bus.subscribe()` for loose coupling
- **NamedError**: `NamedError.create()` for typed, structured errors
