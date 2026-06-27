# AGENTS.md

Guidelines for AI coding agents and developers working in this repository.

## Repository Reality

Synergy is an open-source AI agent platform built as a Bun monorepo with TypeScript ESM modules.

Before changing code or docs, verify the implementation you are touching.

Synergy has multiple product surfaces:

- a stateless server runtime
- a Web client
- a production Electron desktop client
- one-off CLI execution via `send`
- configurable agents and subagents
- session persistence
- MCP integration
- channels and Holos-related identity flows
- agenda and automation features
- note, library, and community-facing capabilities

## Architecture Vocabulary

Use repository vocabulary consistently.

- Use `Scope` for scope resolution and workspace context.
- Use `library` terminology for the knowledge/memory subsystem.
- Use the session management terminology and CLI command names implemented in the current source.
- Migration-history documents are the only place for retired names.

## Monorepo Map

### Primary packages

- `packages/synergy` — core runtime, server, CLI, sessions, tools, permissions, integrations, orchestration
- `packages/app` — main Web application
- `packages/desktop` — Electron desktop app, managed local server host, packaging, signing, updates
- `packages/plugin` — plugin SDK published as `@ericsanchezok/synergy-plugin`
- `packages/plugin-kit` — standalone plugin development CLI published as `@ericsanchezok/synergy-plugin-kit`
- `packages/sdk/js` — TypeScript SDK published as `@ericsanchezok/synergy-sdk`
- `packages/ui` — shared UI component library
- `packages/util` — shared utilities and error helpers
- `packages/script` — build and release utilities

### Important Areas in `packages/synergy/src`

Work commonly touches these domains:

- `agent/` — built-in agent definitions and prompts
- `agenda/` — scheduling and autonomous task execution
- `bus/` — eventing
- `channel/` — external messaging/channel integrations
- `cli/` — CLI commands, startup flows, and user-facing entrypoints
- `config/` — config loading, merging, resolution, setup
- `control-profile/` — resolved permission/sandbox profile definitions and compiler
- `cortex/` — task orchestration and background execution
- `enforcement/` — capability classification and centralized tool boundary gate
- `library/` — memory/knowledge infrastructure
- `mcp/` — MCP support
- `note/` — notes system
- `permission/` — permission model
- `process/` and `pty/` — process/runtime plumbing
- `provider/` — LLM provider integration
- `scope/` — scope resolution and context
- `sandbox/` — OS sandbox backend wrappers for process execution
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

Docs and code comments should describe the client-server runtime model.

## Development Commands

### Primary development flow

Use the root `bun dev` command as the source-checkout development orchestrator. It is separate from the installed/product `synergy` CLI.

```bash
bun dev prepare
```

Common source development flows:

```bash
bun dev server                # server only, fixed development port
bun dev app --open            # Vite web app against an existing server
bun dev web                   # server + Vite web app
bun dev desktop               # server + Vite web app + Electron desktop shell
bun dev desktop --managed     # Electron desktop shell with managed server mode
```

One-off CLI execution from source:

```bash
bun dev send "your message here"
```

Targeted builds:

```bash
bun dev build app
bun dev build desktop
```

`packages/desktop` production builds use `electron-builder`, app id `io.holosai.synergy`, protocol `synergy://`, and managed server mode by default. Daily desktop development should use `bun dev desktop`, which defaults to external mode against the Vite app and local server.

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

### Frontend API calls

Frontend code should use the generated SDK for Synergy server APIs. Avoid hand-written `fetch()` calls for internal Synergy routes.

- Use `createSynergyClient()` / existing SDK contexts for internal Synergy routes.
- If a server route is needed by the frontend but is missing from the SDK, add OpenAPI metadata to the route, run `./script/generate.ts`, and call the generated SDK method.
- Do not duplicate route URLs, query parsing, response shapes, or error handling in app code when an SDK method can represent the same contract.
- Keep raw browser APIs only for cases the SDK should not abstract: WebSocket/EventSource streams, external URLs, browser downloads/uploads where no SDK route exists, local file/blob handling, and platform-provided `fetch` injection into the SDK client.
- When replacing raw `fetch()` with SDK calls, preserve auth behavior, directory/scope parameters, error semantics, and response URL formats such as asset URLs.

### Browser workspace architecture

The built-in Browser workspace has two interactive presentation modes:

- desktop-local native mode through Electron `WebContentsView`
- Web remote mode through WebRTC media plus data-channel input

Keep those modes as first-class paths. Do not add screenshot-stream, iframe, pseudo-tab, adapter, or compatibility fallback paths for the interactive Browser workspace. Shared browser behavior belongs in clear domain modules such as workspace control, host control, and WebContents command execution; mode-specific code should own only presentation lifecycle.

Browser session reads are state reads. `GET /browser/session`, events WS open, and WebRTC signaling open must not create tabs. Tab creation belongs to explicit control commands such as `createTab`, including address-bar navigation from an empty workspace.

Workspace resize commands use CSS viewport width and height. Keep Playwright/tool-only viewport details such as device scale factor out of workspace resize messages unless both native and remote presentations implement the same semantics.

Remote Browser input must preserve local-browser expectations: pointer focus, text caret in the page, IME composition, paste, wheel, and keyboard shortcuts. Treat host pending/ready/loading as connection state, not as fatal Browser errors.

### Frontend icon semantics

Non-tool product UI icons must use semantic tokens from `packages/ui/src/components/semantic-icon.tsx`.

- Add a token before introducing icons for new app shell, sidebar, status bar, settings, notes, browser, navigation, state, or action semantics.
- Reuse a token only when the UI element has the same meaning. If a Lucide glyph appears under multiple tokens, the overlap must be intentional and covered by semantic icon tests.
- Raw Lucide icon literals are allowed only for narrow generic actions with an explicit reason. Prefer tokens such as `action.close`, `action.add`, `action.search`, `navigation.back`, and section-specific `settings.*` tokens.
- Tool cards remain governed by the tool registry, `message-part` metadata, `tool-renders`, taxonomy, and classifier rules below.

## Code Style

### General principles

- Fix root causes, not just symptoms.
- Prefer minimal, focused changes.
- Match the surrounding style.
- Do not add inline comments unless explicitly requested.
- Do not add copyright or license headers.
- Do not introduce unrelated cleanup while working on a task.

### Compatibility and migrations

- Do not accumulate adapters, fallback branches, or compatibility layers in core code as a substitute for a clean model.
- Prefer one explicit code path. Use the relevant Synergy migration module and central migration runner for persisted state, schema data, or protocol records that need upgrades.
- Keep temporary compatibility shims narrow, named, tested, and removed in the same change whenever migration can make obsolete shapes impossible.
- Do not hide ownership or routing uncertainty behind generic adapters. Define the boundary directly and make the logs/errors trace that boundary.

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
- Database initialization code may create the fresh-install schema, but one-off upgrade logic, backfills, and data rewrites belong in migrations.
- If a persistence change affects existing data, add or update a migration in the same task.
- When changing migrations, verify the startup path that runs them and test both the narrow affected area and any relevant integration surface.

## Configuration Rules

### Config Locations

Primary global config uses one canonical domain directory under:

```bash
~/.synergy/config/synergy.d/
```

The domain files are:

```bash
00-general.jsonc
10-models.jsonc
20-providers.jsonc
30-library.jsonc
40-mcp.jsonc
50-plugins.jsonc
60-agents.jsonc
70-commands.jsonc
80-permissions.jsonc
90-channels.jsonc
100-holos.jsonc
110-email.jsonc
120-runtime.jsonc
```

Project-level config uses the same domain layout under:

```bash
<project>/.synergy/synergy.d/
```

Project instruction discovery is configured in the agents domain. `AGENTS.override.md` is preferred over `AGENTS.md`; `project_doc_fallback_filenames` can add fallback names such as `PRODUCT.md` or `WORKFLOW.md`; `instructions` remains an explicit append list.

Monolithic config files are handled only by migrations. Do not add runtime load paths for them.

Provider auth paths are distinct. The built-in `openai-codex` provider uses ChatGPT/Codex OAuth device-code credentials and the Codex backend; the normal `openai` provider remains the OpenAI Platform API-key path. Do not merge their config, auth storage semantics, or billing language.

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
- control profile or sandbox config behavior

then review both `README.md` and any related setup/help text.

## Tool and Agent Work

### Agent Reality

The repository has two built-in primary orchestrators: `synergy` for the classic general workflow and `synergy-max` for the expanded coding-harness workflow. Built-in subagents are scoped with visibility masks: classic subagents such as `developer`, `explore`, `scout`, `advisor`, `inspector`, `scribe`, and `scholar` are visible to `synergy`; coding-harness and knowledge subagents such as `intent-analyst`, `requirements-engineer`, `code-cartographer`, `solution-architect`, `test-strategist`, `implementation-engineer`, `research-scout`, `docs-researcher`, `literature-searcher`, `literature-analyst`, `research-methodologist`, `quality-gatekeeper`, `memory-curator`, `note-librarian`, `session-historian`, and reviewer agents are visible to `synergy-max`.

Built-in primary agent names are `synergy` and `synergy-max`. The classic coding executor is `developer`; the coding-harness executor is `implementation-engineer`.

### Tool implementation

Tools are defined with `Tool.define()`. Match the current local pattern in the relevant file before making changes.

When editing tool definitions:

- keep parameter schemas precise
- return structured metadata where existing tools do so
- preserve permission expectations
- consider SDK and route implications if tool shapes become API-visible

### Tool frontend registration

Adding a new tool requires registering it in **four** places for full UI support:

1. **`packages/ui/src/components/icon.tsx`** — import the Lucide icon component and add it to the `icons` map. Pick an icon not used by any existing tool.
2. **`packages/ui/src/components/message-part.tsx`** — add a `case` in `getToolInfo()` returning `{ icon, title, subtitle, args }`. This drives the tool card display for both direct renders and the task summary list.
3. **`packages/ui/src/components/tool-renders.tsx`** — append the tool name to its group array (e.g. `inspireToolNames`, `researchToolNames`) so `ToolRegistry.register` picks it up with the shared render logic.
4. **`packages/synergy/src/tool/taxonomy.ts`** — add an entry with the correct domain kind and traits (`stateful`, `externalIO`).
5. **`packages/ui/src/components/tool/classifier.ts`** — add the tool to `TOOL_CATEGORIES` with the appropriate semantic category, so the fallback classifier works if steps 2–3 are missed.

Skipping any of these causes the tool to fall back to a generic icon and label, or to miss permission/state tracking.

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
  the test to implementation wording. Prefer calling the function
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
- desktop packaging, signing, updating, managed server startup, or protocol handling
- package ownership or package responsibilities
- user-facing product areas such as MCP, channels, login, identity, agenda, notes, library, Agora, or Web behavior

At minimum, check whether `README.md` and `AGENTS.md` need updates.

### Documentation style

Write docs as the final current state of the system.

- Describe the supported behavior directly. Avoid framing docs as "previously X, now Y" or "not X, but Y" when the reader only needs Y.
- Remove obsolete design notes, migration narratives, and stale architecture explanations instead of preserving them with caveats.
- Keep migration history only in dedicated migration or release-history documents where the history itself is the subject.
- Prefer concise product and architecture facts over rationale about retired implementations.
- When a document conflicts with code, update the document to the implementation and delete stale wording.

When a change affects product design, interaction structure, visual hierarchy, or durable UX taste, also update `packages/app/PRODUCT.md` in the same task. Treat that file as the Web product contract for principles that should survive future frontend refactors.

For frontend surface work, follow the polarity rule in `packages/app/PRODUCT.md`: in dark mode, content and selected surfaces should step brighter than their containers; in light mode, content and selected surfaces should step darker. If a feature cannot use the shared workbench classes directly, add scoped tokens that preserve that same outer-to-inner lightness order.

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

The release workflow has two targets:

- `product` for the full Synergy release, including app, desktop installers, schema, binaries, npm wrapper, platform packages, SDK, plugin SDK, plugin kit, and meta-protocol.
- `packages` for package-only npm releases such as `plugin-kit`, `plugin`, `sdk`, and `meta-protocol`; this path does not build app/binaries or create product GitHub release assets.

If you change release behavior, update the internal documentation in the same task.

Desktop release behavior is documented in `docs/desktop-release.md`. If you touch `packages/desktop`, `.github/workflows/release.yml`, Electron signing/updater config, or desktop release scripts, review that runbook and keep artifact names, required secrets, and failure recovery steps in sync.

## Project Documentation Index

Key documents in the repo that agents should be aware of:

- `README.md` — project overview, development setup, architecture, and full command reference
- `CONTRIBUTING.md` — contribution guide: setup, PR process, code style, commit guidelines
- `CODE_OF_CONDUCT.md` — community code of conduct
- `.github/SECURITY.md` — security vulnerability reporting process (never open public issues for security bugs)
- `.github/PULL_REQUEST_TEMPLATE.md` — required PR template (what/why/test/checklist)
- `.github/RELEASE_NOTES_TEMPLATE.md` — release notes format and writing guidelines
- `docs/desktop-release.md` — desktop packaging, signing, update, and release runbook
- `packages/app/PRODUCT.md` — Web product principles, interaction model, and visual design contract
- `packages/synergy/AGENTS.md` — agent guidelines specific to the core runtime package
- `packages/app/AGENTS.md` — agent guidelines specific to the web app package

## Practical Working Rules for Agents

- Read first, then edit.
- Verify command names against the current CLI.
- Verify config paths against the implementation.
- Search before assuming a concept name exists.
- Prefer product terminology used by the current source.

## When Unsure

If you discover tension between a document and the code:

- trust the implementation
- update the document
- remove stale wording
