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
- `packages/synergy-link` — Synergy Link remote collaboration
- `packages/synergy-link-protocol` — Link protocol definitions
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
- `daemon/` — daemon process lifecycle and lock management
- `enforcement/` — capability classification and centralized tool boundary gate
- `global/` — global paths, `SYNERGY_HOME` resolution, installation root
- `library/` — memory/knowledge infrastructure
- `mcp/` — MCP support
- `migration/` — central migration runner for persisted state upgrades
- `note/` — notes system
- `observability/` — structured event tracing and diagnostics
- `permission/` — permission model
- `process/` and `pty/` — process/runtime plumbing
- `provider/` — LLM provider integration
- `sandbox/` — OS sandbox backend wrappers for process execution
- `scope/` — scope resolution and context
- `server/` — HTTP server and API routes
- `session/` — session lifecycle, prompting, recall, summaries, progress
- `skill/` — skill loading and built-ins
- `storage/` — file-based JSON persistence (sessions, messages, permissions, etc.)
- `tool/` — tool implementations

If you touch files in one area, scan adjacent domains before assuming the abstraction boundary.

## Core Runtime Model

Synergy uses a client-server model.

Key practical consequence:

- the server is central and stateless relative to a single project directory
- clients attach to it and provide a working directory or scope context
- many CLI flows are built around `server` first, then `web` or `send`

Docs and code comments should describe the client-server runtime model.

### Message and sync model

The session/message core follows two orthogonal-field designs. Read the design docs before touching message assembly, the loop, inbox, undo/rewind, or frontend data loading — the old tangled booleans they replaced (`metadata.synthetic`, `part.synthetic`, `metadata.noReply`, `metadata.guided`, `part.ignored`, `metadata.promptVisible`, the `metadata.source` family) must not come back.

Backend message semantics (`docs/architecture/session-message-core.md`, implemented across `packages/synergy/src/session/*`):

- A message is described by orthogonal canonical fields, not overloaded booleans: `rootID`/`isRoot` (scheduling/task grouping), `visible` (frontend rendering), `includeInContext` (model context), and `origin` (provenance, closed enum). Parts carry `origin: "user" | "system"`.
- `MessageV2.deriveSemantics(messages)` is the single read-time derivation (in `history.ts` and storage migration); `MessageV2.isSystemPart(part)` is the canonical system-part test. Do not re-derive these ad hoc.
- The loop binds one root user message `R`; every assistant message in that task has `rootID = R.id` and `parentID = R.id` (no parent drift). Compaction resolves its anchor in O(1) from `parentID`.
- Inbox items use a single `mode` axis (`task` / `steer` / `context`); there is no separate in-memory mailbox.

Frontend data sync (`docs/architecture/frontend-data-sync.md`, implemented across `packages/app/src/context/*` and the bus/server sequence plumbing):

- Store writes always `reconcile` (never whole-object replace), so an event that changes one field does not invalidate the whole reactive chain.
- State events carry a scope-monotonic `seq` + per-runtime `epoch` (`bus/sequencer.ts`); streaming part-delta events are unsequenced. Scoped GET responses advertise a snapshot watermark via `x-synergy-seq`/`x-synergy-epoch` headers. On reconnect the client replays missed events via `/event/replay` (fail-open to a full resync).
- Composer model/agent resolve through strict layers — user draft → session default (server `modelOverride`, else last root message) → fallback — and lower layers never write back up (the #318 fix). An explicit selector pick persists as `modelOverride`.
- Streaming part disk writes are coalesced (write-behind) while discrete/terminal writes stay immediate; loaded message/part buckets are LRU-evicted with the active session protected.

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
bun dev desktop --managed     # rebuild Web app dist + Electron desktop shell with managed server mode
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

`packages/desktop` production builds use `electron-builder`, app id `io.holosai.synergy`, protocol `synergy://`, and managed server mode by default. Daily desktop development should use `bun dev desktop`, which defaults to external mode against the Vite app and local server. Use `bun dev desktop --managed` when validating the production-style managed server path; it rebuilds the Web app dist before launching Electron so stale frontend assets do not mix with current desktop/server code.

### Developing Synergy with Synergy

When you are modifying Synergy source code while using Synergy itself, always use an **isolated second instance**. Never stop, restart, or disrupt the running session you are talking to.

Synergy uses `SYNERGY_HOME` to redirect the entire `.synergy/` directory (data, logs, config, daemon state, lock files). Set it to a temporary path to avoid `AlreadyRunningError` and port conflicts:

```bash
# One-time setup — creates isolated directory and copies your config
mkdir -p /tmp/synergy-dev
cp -r ~/.synergy/config /tmp/synergy-dev/.synergy/config

# Start an isolated dev instance (pick mode; use ports that don't conflict)
SYNERGY_HOME=/tmp/synergy-dev bun dev web --server-port 4097 --app-port 3001
# SYNERGY_HOME=/tmp/synergy-dev bun dev desktop --server-port 4097 --app-port 3001
# SYNERGY_HOME=/tmp/synergy-dev bun dev desktop --managed --server-port 4097 --app-port 3001
```

Rules:

- Always use explicit `--server-port` and `--app-port` that differ from the running instance
- Always copy `~/.synergy/config` into the isolated directory (preserves provider settings without copying the separate credential store)
- Never run `synergy stop` or `kill` on the main instance process

The `develop-synergy` skill (`skill(name: "develop-synergy")`) has the full workflow.

### Quality commands

```bash
bun run format:check       # check formatting with prettier
./script/format.ts          # auto-format all files
bun run lint                # lint with oxlint (errors + warnings)
bun run lint:fix            # lint with auto-fix
bun run typecheck           # type-check all packages via turbo
bun run deadcode            # check dead code and dependency hygiene (knip)
bun run monorepo:check      # validate monorepo dependency consistency (sherif)
bun run workflow:check      # validate CI workflow files (actionlint)
bun run secrets:check       # scan for secrets (gitleaks)
bun run package:check       # validate publishable packages (publint + attw)
bun run quality:quick       # format:check + lint + typecheck + monorepo:check + package:check
bun run quality             # quality:quick + all tests (turbo test)
```

`bun run quality:quick` is the default local PR preflight. The pre-push hook runs the fast subset: Bun version, format, lint, typecheck, and monorepo checks. CI runs the full matrix: quality, typecheck, test, package-validation, workflow-validation, secret-scan, desktop, and smoke jobs. See [docs/open-source-quality.md](docs/open-source-quality.md) for the complete model.

### Tests

Run tests from `packages/synergy`, not from repo root:

```bash
cd packages/synergy
bun test
bun test test/tool/read.test.ts
bun run test:changed
bun run test:coverage
bun test --watch
```

Tests seed the model catalog from the pinned fixture `packages/synergy/test/tool/fixtures/models-api.json`, not from live `models.dev` (`test/preload.ts`). This keeps provider/model tests deterministic and drift-proof: a live catalog that renames or removes a referenced model must never turn CI red. When a test needs a model the fixture lacks, update the fixture deliberately rather than reintroducing a live fetch.

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

Browser workspace state is one session to one page. `GET /browser/session`, events WS open, and WebRTC signaling open must not create a page. The first address-bar navigation or browser tool navigation creates the page; later navigation reuses that page. Do not reintroduce workspace tab commands, tab strips, pseudo-tabs, or multi-page session merges.

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

### Control profile semantics

`full_access` is the author-at-own-risk profile: the permission system must silently allow every capability, including protected paths, secrets, destructive or hardline shell commands, external writes, identity/channel actions, and plugin/platform operations. It does not suppress non-permission failures such as validation errors, missing files, OS permission errors, failed tests, hooks, or network failures.

`autonomous` is the unattended profile: it must never ask the user. Operations that cannot be automatically allowed must be automatically denied with a clear policy diagnostic. SmartAllow may auto-allow eligible false positives at high confidence, but failed SmartAllow checks deny instead of prompting.

`guarded` is the interactive profile: it is the only standard profile that can ask the user for permission. Do not add ask flows to `autonomous`; if an unattended operation exceeds its policy, deny it.

`smartAllow` reduces noise and false positives. In `guarded`, it can auto-allow safe asks before prompting. In `autonomous`, it can auto-allow eligible soft denies at a stricter threshold. It must use metadata or redacted evidence for secret-like files and must never send raw secret values to a model.

External reads are allowed by default, including ordinary reads from a worktree session's original checkout. Do not treat non-sensitive `file_external_read` as a protected operation merely because it is outside the active workspace. Sensitive regions remain protected: credentials, secrets, private auth stores, and other explicit sensitive-path matches must still be denied or gated according to the active profile.

Worktree isolation blocks writes, modifications, and execution outside the active worktree unless the active profile explicitly allows them. In particular, a worktree session may read ordinary files in the original checkout, but must not write to, modify, or run commands from the original checkout under `autonomous`.

Skill roots are trusted runtime areas. Reading, writing, and running inside configured skill/plugin skill roots is allowed by the permission model; do not reclassify those paths as ordinary external writes or external execution unless they escape the trusted root.

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

The repository has two built-in primary orchestrators: `synergy` for the classic general workflow and `synergy-max` for the expanded coding-harness workflow. Built-in subagents are scoped with visibility masks: classic subagents such as `developer`, `explore`, `scout`, `advisor`, `inspector`, `scribe`, and `scholar` are visible to `synergy`; coding-harness and knowledge subagents such as `intent-analyst`, `requirements-engineer`, `code-cartographer`, `solution-architect`, `test-strategist`, `implementation-engineer`, `research-scout`, `docs-researcher`, `literature-searcher`, `literature-analyst`, `research-methodologist`, `quality-gatekeeper`, `memory-curator`, `note-librarian`, and `session-historian` are visible to `synergy-max`.

Built-in primary agent names are `synergy` and `synergy-max`. The classic coding executor is `developer`; the coding-harness executor is `implementation-engineer`. Hidden built-in review subagents include `supervisor` (BlueprintLoop audit) and `lightloop-reviewer` (LightLoop completion verification). They remain `mode: "subagent"` and `hidden: true`, so they are not primary-selectable and are not direct `task` targets for primary agents. Hidden reviewers may delegate specialist subagents internally through configured `delegationGroups`; `lightloop-reviewer` uses the supervisor delegation group.

### Tool implementation

Tools are defined with `Tool.define()`. Match the current local pattern in the relevant file before making changes.

When editing tool definitions:

- keep parameter schemas precise
- return structured metadata where existing tools do so
- preserve permission expectations
- consider SDK and route implications if tool shapes become API-visible

### Tool frontend registration

Adding a new tool requires registering it in **five** places for full UI support:

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
- If a pre-push or prepush check fails, agents may make the narrow fixes required by that hook, verify them, commit the fix directly, and retry the push. Do not bypass the hook or leave required fixes uncommitted.

- Verify quality commands against the actual root scripts (`package.json`) before referencing them. `bun run quality:quick` is the default local PR preflight; the pre-push hook runs a fast subset; `bun run quality` runs the full suite with tests.
- When changes add or modify quality scripts, CI jobs, or pre-push hooks, update `docs/open-source-quality.md` and the affected agent guides.

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

When a change affects agent-facing workflows — adding/modifying/removing agents, CLI commands, tools, startup flows, config paths, log locations, storage layout, test patterns, or development workflows — also update the relevant project skill or command under `.synergy/skill/` and `.synergy/command/`. These files are the agent's primary source of truth for how to develop Synergy correctly. Letting them drift produces broken instructions on the next `skill(name: "...")` load.

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

Do not push directly to `dev` or `main`.

### Collaboration flow

- **Internal team members**: create branches directly in the repo, open PRs against `dev`.
- **External contributors**: fork the repo, create branches in the fork, open PRs against `dev`.
- **All PRs target `dev`**, never `main`.

### Release process

Releases are triggered through GitHub Actions. Keep versioning and release docs aligned with the actual scripts and workflow in the repo.

The release workflow has two targets:

- `product` for the full Synergy release, including app, desktop installers, schema, binaries, npm wrapper, platform packages, SDK, shared util package, plugin SDK, plugin kit, and synergy-link-protocol.
- `packages` for package-only npm releases such as `plugin-kit`, `plugin`, `util`, `sdk`, and `synergy-link-protocol`; this path does not build app/binaries or create product GitHub release assets.

If you change release behavior, update the internal documentation in the same task.

Desktop release behavior is documented in `docs/desktop-release.md`. If you touch `packages/desktop`, `.github/workflows/release.yml`, Electron signing/updater config, or desktop release scripts, review that runbook and keep artifact names, required secrets, and failure recovery steps in sync.

## Project Documentation Index

Key documents in the repo that agents should be aware of:

- `README.md` — project overview, development setup, architecture, and full command reference
- `CONTRIBUTING.md` — contribution guide: setup, PR process, code style, commit guidelines
- `CODE_OF_CONDUCT.md` — community code of conduct
- `.github/SECURITY.md` — security vulnerability reporting process (never open public issues for security bugs)
- `.github/PULL_REQUEST_TEMPLATE.md` — required PR template (what/why/test/checklist)
- `docs/open-source-quality.md` — quality model, CI jobs, pre-push hook, package validation, contributor scenarios
- `docs/desktop-release.md` — desktop packaging, signing, update, and release runbook
- `docs/architecture/session-message-core.md` (+ `docs/architecture/session-message-core/`) — backend message/session semantics: orthogonal `rootID`/`visible`/`includeInContext`/`origin` fields, the serial-task loop, compaction anchor, and inbox `mode`
- `docs/architecture/frontend-data-sync.md` — frontend data sync: reconcile writes, the `seq`/`epoch` sequence protocol + replay, snapshot watermark headers, composer intent layering, part write-behind, and bucket eviction
- `packages/app/PRODUCT.md` — Web product principles, interaction model, and visual design contract
- `packages/synergy/AGENTS.md` — agent guidelines specific to the core runtime package
- `packages/app/AGENTS.md` — agent guidelines specific to the web app package

## Parallel Development and Git Safety

The repository is commonly used by multiple agents at the same time. Protect the shared checkout from branch changes and use pull requests as the CI gate for `dev`.

- **Never push directly to `dev` or `main`.** Changes intended for the repository belong on a topic branch and reach `dev` through a pull request after CI passes. `main` is updated only by the release workflow.
- **Do not switch the branch of a shared or pre-existing checkout.** Another session may be using its current branch or uncommitted files. If the task needs a different branch, create or enter a worktree instead of running `git checkout` or `git switch` in that checkout.
- **Use worktrees for branch isolation, not as a requirement based on task size or type.** Reuse an existing worktree for follow-up work on the same branch. If the session is already in the correct task-owned checkout, continue there rather than creating another worktree.
- **Inspect the working tree before editing or staging.** Existing changes may belong to another session. Preserve unrelated modifications and stage only files owned by the current task.
- **Keep commits and remote publication on topic branches.** In autonomous sessions, the permission model allows ordinary branch publication from worktrees and blocks remote writes from the shared checkout, so enter the task's worktree before pushing or creating a pull request.

Detailed workflows are documented in project-local skills under `.synergy/skill/`:

- `skill(name: "git-guide")` — commit rules, PR workflow, data leak prevention, amend/rebase safety
- `skill(name: "develop-synergy")` — isolated second instance, SYNERGY_HOME, multi-worktree port management
- `skill(name: "testing-guide")` — TDD philosophy, test patterns, fixtures, quality gates
- `skill(name: "architecture")` — package map, domain layout, request flow, common patterns
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
