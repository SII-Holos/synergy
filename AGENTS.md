# AGENTS.md

Guidelines for AI coding agents and developers working in this repository.

## Repository Reality

Synergy is an open-source AI agent platform built as a Bun monorepo with TypeScript ESM modules.

This repository has evolved substantially. Do not assume older README text, old blog-style architecture notes, or legacy naming still reflect the current system. Before changing code or docs, verify the current implementation.

Synergy is an AI agent platform with multiple product surfaces. The current product surface includes:

- a stateless server runtime
- a Web client
- one-off CLI execution via `send`
- configurable agents and subagents
- session persistence
- MCP integration
- channels and Holos-related identity flows
- agenda and automation features
- note, memory/engram, and community-facing capabilities

## Current Architecture Vocabulary

Use current terms consistently.

- Prefer `Scope` over older `Project`-centric descriptions when referring to current scope resolution and workspace context.
- Prefer current `engram` terminology for the knowledge/memory subsystem rather than older historical naming.
- Prefer current session management terminology and current CLI command names.
- Do not reintroduce old names in new docs unless you are explicitly documenting migration history.

## Monorepo Map

### Primary packages

- `packages/synergy` — core runtime, server, CLI, sessions, tools, permissions, integrations, orchestration
- `packages/app` — main Web application
- `packages/config-ui` — dedicated configuration UI package
- `packages/plugin` — plugin SDK published as `@ericsanchezok/synergy-plugin`
- `packages/sdk/js` — TypeScript SDK published as `@ericsanchezok/synergy-sdk`
- `packages/ui` — shared UI component library
- `packages/util` — shared utilities and error helpers
- `packages/script` — build and release utilities

### Important areas in `packages/synergy/src`

Current work commonly touches these domains:

- `agent/` — built-in agent definitions and prompts
- `agenda/` — scheduling and autonomous task execution
- `bus/` — eventing
- `channel/` — external messaging/channel integrations
- `cli/` — CLI commands, startup flows, and user-facing entrypoints
- `config/` — config loading, merging, resolution, setup
- `cortex/` — task orchestration and background execution
- `engram/` — memory/knowledge infrastructure
- `mcp/` — MCP support
- `note/` — notes system
- `permission/` — permission model
- `process/` and `pty/` — process/runtime plumbing
- `provider/` — LLM provider integration
- `scope/` — scope resolution and context
- `server/` — HTTP server and API routes
- `session/` — session lifecycle, prompting, recall, summaries, progress
- `skill/` — skill loading and built-ins
- `tool/` — tool implementations

If you touch files in one area, scan adjacent domains before assuming the abstraction boundary.

## Core Runtime Model

Synergy uses a client-server model.

Key practical consequence:

- the server is central and stateless relative to a single project directory
- clients attach to it and provide a working directory or scope context
- many CLI flows are built around `server` first, then `web` or `send`

Do not write docs or code comments that assume the old "single local CLI process bound to one directory" mental model.

## Development Commands

### Primary development flow

Build the frontend first (required before the server can serve the Web UI):

```bash
bun run --cwd packages/app build
```

Then start the server:

```bash
bun dev
```

This starts the server from `packages/synergy` and preserves the invoking directory via `SYNERGY_CWD`.

Connect clients from another terminal:

```bash
bun dev web --dev
bun dev send "your message here"
```

### Type checking and formatting

```bash
bun run typecheck
./script/format.ts
```

### Tests

Run tests from `packages/synergy`, not from repo root:

```bash
cd packages/synergy
bun test
bun test test/tool/read.test.ts
bun test --watch
```

### Build and SDK generation

```bash
./packages/synergy/script/build.ts --single
./script/generate.ts
```

Regenerate the SDK after modifying server routes or route schemas.

## Code Style

### General principles

- Fix root causes, not just symptoms.
- Prefer minimal, focused changes.
- Match the surrounding style.
- Do not add inline comments unless explicitly requested.
- Do not add copyright or license headers.
- Do not introduce unrelated cleanup while working on a task.

### Module organization

Use namespace-based organization where that is the established local pattern.

```ts
export namespace Tool {
  export function define(...) {}
  export interface Info {}
}
```

Prefer extending existing patterns over introducing a parallel style.

### Imports

- `@/` aliases and relative imports are both used
- named imports are preferred where appropriate
- import `z` from `"zod"` as default

```ts
import z from "zod"
```

### Types and validation

- use Zod for runtime validation
- add `.meta({ ref: "TypeName" })` for API-exposed schemas where needed
- infer TypeScript types from schemas
- avoid `any`

### Variables and control flow

- prefer `const`
- use early returns to reduce nesting
- avoid unnecessary destructuring when it harms clarity or context

### Error handling

- use `NamedError.create()` for domain-specific errors where that pattern already exists
- use custom error classes when needed
- preserve useful structured error data

### Async patterns

- prefer `async` / `await`
- use `Promise.all()` for real parallelism
- use async generators where streaming is already part of the local pattern

### File operations

Use Bun APIs in code where appropriate.

```ts
const file = Bun.file(filepath)
await file.exists()
await file.text()
await Bun.write(filepath, content)
```

### Migration discipline

Treat schema and data migrations as a first-class architectural concern.

- Put versioned persistence upgrades in the dedicated migration modules and runner, not inline in request handlers, business logic, or ad hoc startup code.
- For `packages/synergy/src`, prefer the domain migration files such as `*/migration.ts` plus the central `packages/synergy/src/migration` runner.
- Database initialization code may create the current schema for fresh installs, but one-off upgrade logic, backfills, and legacy data rewrites belong in migrations.
- If a persistence change affects existing data, add or update a migration in the same task rather than silently relying on new code paths to repair old rows over time.
- When changing migrations, verify the startup path that runs them and test both the narrow affected area and any relevant integration surface.

## Configuration Rules

### Current config locations

Primary global config uses the active global Config Set under:

```bash
~/.synergy/config
```

The `default` Config Set maps to:

```bash
~/.synergy/config/synergy.jsonc
```

Project-level config is resolved from the working tree and may include:

```bash
synergy.jsonc
synergy.json
.synergy/
```

When editing or documenting config, prefer `synergy.jsonc` as the primary file name unless you are specifically describing compatibility behavior.

### Config-aware work

If you change:

- provider config handling
- model resolution
- agent loading
- command loading
- plugin loading
- `.synergy/` conventions
- MCP config shape
- channel config shape

then review both `README.md` and any related setup/help text.

## Tool and Agent Work

### Current agent reality

The repository now centers on a richer built-in agent set, including `synergy`, `master`, `scholar`, `scribe`, `explore`, `scout`, `advisor`, and others.

Do not reintroduce stale agent documentation such as old "master / plan / scribe" summaries unless you are explicitly updating migration notes.

### Tool implementation

Tools are defined with `Tool.define()`. Match the current local pattern in the relevant file before making changes.

When editing tool definitions:

- keep parameter schemas precise
- return structured metadata where existing tools do so
- preserve permission expectations
- consider SDK and route implications if tool shapes become API-visible

## Testing and Verification

### Test philosophy

- **Test invariants, not implementations.** A good test verifies a behavioral contract
  that survives refactoring — if you rewrote the code differently, the test should still
  pass. A bad test breaks when internals change but behavior doesn't. Example:
  `Intent.sanitize` tests check that hallucinated tool calls produce fallbacks; this
  invariant holds regardless of how sanitization is implemented.

- **Write the test first when adding behavior or fixing bugs.** The test captures what
  "correct" means before you're biased by the implementation. For pure refactoring
  (behavior unchanged), no new tests are needed.

- **Avoid testing source text.** Checking that source code contains or lacks specific
  strings (e.g., verifying a flag is absent from a command) is brittle — it couples
  the test to implementation wording rather than behavior. Prefer calling the function
  and checking the result.

- **Test location:** `packages/synergy/test/{domain}/`, mirroring the `src/` directory
  structure. Shared fixtures go in `test/fixture/`.

### After making code changes

- run the narrowest relevant test first
- expand verification if the change affects shared abstractions
- use the repo formatter if formatting is needed
- do not silently ignore failing relevant tests

Do not run root-level `test` scripts expecting the main suite; the root intentionally blocks that path.

## Documentation Sync Rules

This repository changes quickly. Documentation drift is expected unless you actively prevent it.

You must review docs when a change affects:

- CLI command names or usage flow
- agent names or user-facing roles
- config paths or config schema
- server / client startup flow
- package ownership or package responsibilities
- user-facing product areas such as MCP, channels, login, identity, agenda, notes, memory/engram, Agora, or Web behavior

At minimum, check whether `README.md` and `AGENTS.md` need updates.

## Release and Git Workflow

### Branching

The repo uses a two-branch model:

- `dev` for ongoing development
- `main` for releases (only updated via GitHub Actions during release)

Do not push directly to `main`.

### Collaboration flow

- **Internal team members**: create branches directly in the repo, open PRs against `dev`.
- **External contributors**: fork the repo, create branches in the fork, open PRs against `dev`.
- **All PRs target `dev`**, never `main`.

### Release process

Releases are triggered through GitHub Actions. Keep versioning and release docs aligned with the actual scripts and workflow in the repo.

If you change release behavior, update the internal documentation in the same task.

## Project Documentation Index

Key documents in the repo that agents should be aware of:

- `README.md` — project overview, development setup, architecture, and full command reference
- `CONTRIBUTING.md` — contribution guide: setup, PR process, code style, commit guidelines
- `CODE_OF_CONDUCT.md` — community code of conduct
- `.github/SECURITY.md` — security vulnerability reporting process (never open public issues for security bugs)
- `.github/PULL_REQUEST_TEMPLATE.md` — required PR template (what/why/test/checklist)
- `.github/RELEASE_NOTES_TEMPLATE.md` — release notes format and writing guidelines
- `packages/synergy/AGENTS.md` — agent guidelines specific to the core runtime package
- `packages/app/AGENTS.md` — agent guidelines specific to the web app package

## Practical Working Rules for Agents

- Read first, then edit.
- Verify command names against the current CLI.
- Verify config paths against the current implementation.
- Search before assuming a concept still exists under its old name.
- Prefer current product terminology over historical terminology.

## When Unsure

If you discover tension between an old document and the code:

- trust the current implementation
- update the document
- remove stale wording instead of trying to preserve historical phrasing
