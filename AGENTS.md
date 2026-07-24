# Synergy Repository Rules

These rules apply to the Bun/TypeScript monorepo. Read the nearest package `AGENTS.md` before editing package code.

## Work from Current Evidence

- Verify the implementation, tests, schemas, generated contracts, and current CLI before changing code or docs.
- Use `Scope` for workspace resolution/context and `Library` for the knowledge subsystem. Keep retired names inside `docs/migrations/` or `docs/research/` only.
- Start architecture work at [docs/README.md](docs/README.md), then read only the relevant product, architecture, reference, plugin, or operations document.
- Inspect adjacent domains before assuming a directory is the abstraction boundary.
- Keep a nearest `AGENTS.md` in every workspace package and update it when that package's ownership, public boundary, or verification commands change.
- Fix the root cause with a focused change; preserve unrelated user work and avoid opportunistic cleanup.

The project-local `architecture` skill provides the code-tracing workflow. It links to the canonical documents rather than duplicating their contents.

## Protect Checkouts and Runtimes

The primary checkout, pre-existing checkouts, and active Synergy runtime may be shared by concurrent sessions.

- Inspect `git status`, the current branch, and the worktree list before editing or performing Git operations. Direct edits in the current checkout are allowed; preserve unrelated dirty and untracked files.
- Do not run `git checkout`, `git switch`, or rebase a shared or pre-existing checkout unless the user explicitly requests that operation. These commands change repository state observed by every session using that directory.
- A user may choose to create or use a topic branch directly in the primary checkout. Use a task-owned worktree when concurrent work needs branch or file isolation, not as a prerequisite for every repository change; reuse an existing task worktree when it already owns the branch.
- Stage and commit only when the user requests it. Local commits on `dev` or `main` are permitted, but they advance a potentially shared branch and must never be pushed directly.
- Never push directly to protected `dev` or `main`. Publish a topic branch and open its PR against `dev`; the release workflow is the only path from `dev` to `main`.
- Preserve unrelated dirty and untracked files. Inspect status again before staging and stage only explicit files owned by the current task.
- Do not use destructive Git commands, force pushes, or hook bypasses without explicit user authority and a reviewed recovery plan.
- Push, open a PR, or mutate external systems only when the user requests that action.
- Keep local/runtime paths, session or Scope IDs, logs, credentials, private endpoints, and internal config out of commit messages, PR bodies, comments, and reviews. Project-relative source paths are allowed. Every agent-created commit must use a concise conventional type and end with `Co-authored-by: synergy-agent <299070056+synergy-agent@users.noreply.github.com>`.
- Never stop, restart, signal, or modify the `SYNERGY_HOME` of the Synergy instance carrying the current task.
- Run source changes in an isolated second home with explicit alternate ports. Load `develop-synergy` for the exact workflow.

Load `git-guide` for worktrees, history, commits, rebases, pushes, and PRs.

## Development Entry Points

The root `bun dev` orchestrator is for source development; the installed `synergy` CLI is a product surface.

```bash
bun dev prepare
bun dev server
bun dev app --open
bun dev web
bun dev tui
bun dev desktop
bun dev desktop --managed
bun dev send "request"
```

See [Development reference](docs/reference/development.md) for modes, isolated instances, builds, tests, and SDK generation. Desktop production packaging and updates follow [Desktop release](docs/operations/desktop-release.md).

## Implementation Discipline

- Match established namespace/module patterns. Import `z` from `"zod"`; infer types from schemas and avoid `any`.
- Prefer `const`, early returns, `async`/`await`, and real `Promise.all()` parallelism.
- Preserve structured error data. Use `NamedError.create()` or local error classes where the owning domain already does; match tool-local patterns for tool errors.
- Use Bun file APIs where they improve clarity and match surrounding code.
- Do not add inline comments, headers, adapters, fallbacks, or abstractions unless they explain a durable non-obvious constraint.

### Persistence and compatibility

- Put versioned persisted-state upgrades in the owning domain migration plus the central migration runner. Test fresh-install and upgrade paths.
- Do not scatter one-off backfills through handlers or startup logic.
- Prefer one current code path after migration. Keep unavoidable compatibility shims narrow, named, tested, and time-bounded.
- Do not reintroduce retired session/message booleans or derive canonical semantics outside `MessageV2.deriveSemantics()` and `MessageV2.isSystemPart()`. Read [Sessions and messages](docs/architecture/session-and-messages.md).

### APIs and frontend calls

- Add OpenAPI metadata to server routes and run `./script/generate.ts` after route or API-schema changes.
- Use `createSynergyClient()` and generated methods for internal Web APIs. Reserve raw browser transports for streams, external URLs, browser file/blob flows, and platform-provided fetch injection.
- Preserve auth, Scope/directory parameters, error semantics, and asset URL formats when changing a client call.
- Product color utilities must follow [Frontend themes and color](docs/reference/frontend-theming.md) and resolve through the public canonical contract in `packages/plugin/src/theme`; `packages/ui/src/theme` is the compatibility/runtime application boundary. Do not add Tailwind palette colors, literal color utilities, or component-local light/dark palettes. Change seeds or typed overrides in a structured theme, run the theme generator, and never hand-edit generated Web/Desktop fallbacks or Tailwind color files. Plugin Kit and the host use the same validated Theme JSON parser rather than arbitrary CSS overrides.

### Configuration and credentials

- Canonical global and project config uses the domain files documented in [Configuration](docs/reference/configuration.md). Monolithic config is migration input only.
- Keep `openai-codex` OAuth/Codex-backend auth separate from `openai` Platform API-key auth and billing language.
- Treat auth stores, plugin credentials, diagnostics, logs, and secret-like files as sensitive. Use redacted metadata for model-assisted permission decisions.

## Durable Architecture Boundaries

Read the owning architecture document before changing these areas:

- session/message/compaction and LLM loop: `docs/architecture/session-and-messages.md`, `llm-loop.md`
- frontend snapshots, events, replay, reconcile, and eviction: `frontend-data-sync.md`
- capability classification, control profiles, permissions, and sandbox: `execution-boundaries.md`
- Cortex child sessions and task outputs: `cortex.md`
- Plan, Blueprints, BlueprintLoop, Light Loop, and Lattice: `workflows.md`
- Browser native/WebRTC presentation and one-session/one-page ownership: `browser-runtime.md`

Do not create compatibility paths that violate those contracts. In particular:

- `guarded` is the only standard interactive profile; `autonomous` never asks; `full_access` silently allows permission-system capabilities but cannot suppress ordinary runtime failures.
- Worktree isolation permits ordinary external reads while protecting sensitive paths and blocking unapproved external writes/execution.
- Browser keeps desktop-native `WebContentsView` and Web WebRTC/data-channel presentation as first-class modes. Do not add iframe, screenshot-stream, pseudo-tab, or multi-page session fallbacks.

## Tool, Agent, and Plugin Changes

- Load `add-tool`, `add-agent`, or `add-cli-command` for their complete implementation and verification workflows.
- A first-party tool requires backend registration, taxonomy, and all Web presentation/classifier registrations described by `add-tool`.
- Built-in primary agents are `synergy` and `synergy-max`; visibility masks and delegation groups define each subagent catalog. BlueprintLoop and Light Loop reviewers remain host-selected, while their Cortex tasks are visible in the execution session's Subagent Dock.
- Plugins use the public definition, generated manifest, capability-gated Host Services, process runtime, operation/event/hook, approval, and trusted UI contracts in [Plugin documentation](docs/plugins/README.md). Do not import private runtime modules into plugins.

## Testing and Quality

Write a failing behavioral test first for new behavior and bug fixes. Test public invariants, not source text or incidental implementation. Use real temporary Scope/storage fixtures instead of broad mocks. Load `testing-guide` for detailed selection and isolation rules.

Every test file must live under the `test/` directory of its owning package, mirroring the relevant source domain when useful. Repository-level script and policy tests belong under the root `test/` directory. Do not colocate `*.test.*` or `*.spec.*` files beside files in `src/`, `script/`, or other implementation directories; `bun run test-layout:check` enforces this boundary.

Core tests run from `packages/synergy`:

```bash
cd packages/synergy
bun test test/<domain>/<file>.test.ts
bun run test:changed
bun test
bun run test:ci
bun run test:coverage
```

Frontend package suites run through `bun run --cwd packages/app test` and `bun run --cwd packages/ui test`; both are part of the Turbo test graph.

Repository gates run from the root:

```bash
bun run format:check
bun run lint
bun run localization:check
bun run typecheck
bun run monorepo:check
bun run package:check
bun run quality:quick
bun run quality
```

Run the narrowest relevant test first, expand for shared abstractions, and report every relevant failure. Do not bypass hooks or weaken tests to make a gate pass. The complete local/CI matrix is in [Open-source quality](docs/operations/open-source-quality.md).

## Documentation Ownership

Update documentation in the same task when behavior changes:

- `README.md` — concise repository/product entry point
- `docs/product/` — user-facing objects and flows
- `packages/app/PRODUCT.md` — durable Web interaction and visual principles
- `docs/architecture/` — current implementation invariants
- `docs/reference/` — commands, config, paths, packages, and development procedures
- `docs/plugins/` — public extension contract
- `docs/operations/` — release, quality, and observability runbooks
- `docs/research/` and `docs/migrations/` — investigations and history only
- `.synergy/skill/` and `.synergy/command/` — executable repository workflows

Write current state directly. Delete obsolete explanations instead of layering caveats. When code and docs conflict, verify code/tests, update the canonical document, and remove stale wording elsewhere.

Review at least `README.md`, relevant setup/help text, and the owning Skill whenever a change affects CLI commands, agents, tools, config, paths, startup, logs, storage, tests, packages, release behavior, or user-facing product areas.

### Development standards live in Skills

`.synergy/skill/` is the executable source-development handbook for this repository. When implementation or review reveals a reusable development rule that no Skill currently captures, update the focused owning Skill or create one in the same change. Keep `AGENTS.md` focused on safety, global invariants, and routing; keep step-by-step procedures, examples, and verification checklists in Skills. Load `development-standards` when ownership is unclear.

## Release and Security

- Product and package releases run through `.github/workflows/release.yml`; do not update `main` manually.
- Keep package/release behavior aligned with `docs/operations/desktop-release.md` and `docs/operations/open-source-quality.md`.
- Never open a public issue for a vulnerability. Follow [.github/SECURITY.md](.github/SECURITY.md).

## Repository Skills

- `development-standards` — route source changes and capture new development rules
- `architecture` — trace ownership and cross-cutting flows
- `develop-frontend`, `integrate-llm` — Web/shared UI and model-backed operation workflows
- `change-server-api`, `change-persistence` — API/SDK and durable-state workflows
- `change-execution-boundaries` — capabilities, permissions, control profiles, enforcement, and sandboxing
- `change-browser-runtime` — Browser ownership/control plus Desktop native and WebRTC presentation
- `change-plugin-runtime` — Plugin API 3 definitions, generated artifacts, installation, runtime generations, Host Services, and UI host
- `develop-synergy` — run an isolated second instance
- `testing-guide` — choose fixtures and verification gates
- `git-guide` — worktree, commit, rebase, push, and PR safety
- `add-agent`, `add-cli-command`, `add-tool` — implementation workflows
- `find-logs`, `inspect-sessions` — read-only diagnostics
- `release-log-workflow` — release analysis and authorized publication
