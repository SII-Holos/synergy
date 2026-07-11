# Development Reference

Source development is orchestrated from the repository root with `bun dev`. The installed/product `synergy` CLI is a different surface.

## Requirements and Preparation

The root manifest pins Bun `1.3.14`. Install that version, then run:

```bash
bun dev prepare
```

Preparation installs dependencies, generates OpenAPI/SDK artifacts, builds the plugin SDK and Web app, and prepares the platform sandbox helper where supported. Linux and Windows helper compilation requires Rust; Linux sandboxing also uses Bubblewrap.

## Development Modes

```bash
bun dev server
bun dev app --open
bun dev web
bun dev desktop
bun dev desktop --managed
bun dev send "your message"
bun dev build app
bun dev build desktop
```

| Mode                | Processes                                                                 |
| ------------------- | ------------------------------------------------------------------------- |
| `server`            | source server on fixed development port 4096 by default                   |
| `app`               | Vite app against an existing server; default app port 3000                |
| `web`               | source server plus Vite app                                               |
| `desktop`           | source server, Vite app, and Electron in external-server mode             |
| `desktop --managed` | build plugin/app, then Electron with production-style managed server mode |
| `send`              | one-off source CLI execution                                              |

Use `--server-port`, `--app-port`, `--hostname`, and `--attach` to avoid conflicts. The orchestrator checks required ports and target health before starting dependent processes. In parallel modes it terminates sibling processes when one exits.

Managed Desktop rebuilds the Web distribution before launch so packaged-server behavior is not tested against stale frontend assets. Normal daily Desktop work should use external mode for Vite reload speed.

## Developing Synergy with Synergy

Do not restart or stop the Synergy instance carrying your current session. Run the source checkout against an isolated home and explicit alternate ports:

```bash
mkdir -p /tmp/synergy-dev/.synergy
cp -r ~/.synergy/config /tmp/synergy-dev/.synergy/config

SYNERGY_HOME=/tmp/synergy-dev \
  bun dev web --server-port 4097 --app-port 3001
```

The config copy preserves provider setup while `SYNERGY_HOME` isolates data, logs, daemon state, and locks. Never run `synergy stop` against the main instance as part of a source test.

## Tests

Core runtime tests run from `packages/synergy`:

```bash
cd packages/synergy
bun test
bun test test/tool/read.test.ts
bun run test:changed
bun run test:coverage
bun test --watch
```

Provider/model tests use the pinned `test/tool/fixtures/models-api.json` catalog loaded by `test/preload.ts`. Update the fixture deliberately when a test requires a new model; do not reintroduce live model-catalog fetching into deterministic tests.

Other package tests can run through Turbo or their package scripts:

```bash
bun turbo test
bun run desktop:test
bun run --cwd packages/app test
bun run --cwd packages/ui test
```

The App and shared UI package scripts are part of the Turbo test graph. The App runner isolates its production CSS build contract from ordinary unit tests. The UI runner executes ordinary suites together and isolates the session-turn timeline suite so its global module mocks cannot contaminate neighboring tests.

Theme source changes also regenerate the static boot fallback, Tailwind color mappings, and JSON schema from the canonical token catalog:

```bash
bun run --cwd packages/ui generate:theme
```

Frontend product colors must use the canonical semantic theme contract. Do not add Tailwind palette colors, arbitrary literal color utilities, or component-local light/dark palettes. See [Frontend themes and color](frontend-theming.md) for consumer rules, imperative renderer integration, semantic token changes, and the recommended plugin workflow for creating a selectable theme.

Write behavior tests around public invariants. Avoid source-text assertions that fail when an implementation is refactored without changing behavior.

## Quality Commands

```bash
bun run format:check
./script/format.ts
bun run lint
bun run lint:fix
bun run typecheck
bun run deadcode
bun run monorepo:check
bun run workflow:check
bun run secrets:check
bun run package:check
bun run quality:quick
bun run quality
```

`quality:quick` is the default local PR preflight: format, lint, typecheck, monorepo consistency, and package validation. `quality` adds all Turbo tests. The pre-push hook runs Bun-version, format, lint, typecheck, and monorepo checks; CI runs the wider matrix.

See [Open-source quality](../operations/open-source-quality.md) for exact jobs and failure guidance.

## SDK and Builds

After modifying server routes or OpenAPI-visible schemas:

```bash
./script/generate.ts
```

Build the core single binary/runtime artifact with:

```bash
./packages/synergy/script/build.ts --single
```

Frontend code should use `createSynergyClient()` and generated methods for internal routes. Raw browser transports remain appropriate for WebSocket/EventSource streams, external URLs, browser file/blob handling, and endpoints whose semantics cannot be represented by the SDK.

## Repository Workflow

The development branch is `dev`; `main` is updated by the release workflow. All pull requests target `dev`.

Make repository changes in a task-owned worktree on a topic branch. Do not run `git checkout` or `git switch`, edit, commit, rebase, or publish from the primary/shared checkout. Create or enter the task worktree first, then inspect its status. Reuse that worktree for later changes to the same branch rather than creating a new worktree for every edit.

Never push `dev` or `main` directly. Push only the task topic branch and open its pull request against `dev`; the release workflow is the only path from `dev` to `main`. Preserve unrelated changes, stage explicit task files, and keep local paths, runtime identifiers, logs, credentials, and internal configuration out of commit and GitHub text. See `git-guide` for the commit template, mandatory agent co-author footer, and publication workflow.

Keep changes focused, update migrations for persisted schema changes, and update current-state docs plus relevant `.synergy/skill` workflows whenever an agent-facing command, path, tool, or procedure changes.

### Development workflow ownership

The repository-local `.synergy/skill/` directory is the executable handbook for changing Synergy itself. It is distinct from user-installed Skills and public plugin documentation.

| Change                                                                                           | Owning workflow                                    |
| ------------------------------------------------------------------------------------------------ | -------------------------------------------------- |
| Unclear or cross-cutting source change; new reusable convention                                  | `development-standards`                            |
| Architecture tracing and impact analysis                                                         | `architecture`                                     |
| Web or shared product UI, including semantic icons                                               | `develop-frontend`                                 |
| Internal LLM call, model-backed classifier, existing session invocation, or delegated child task | `integrate-llm`                                    |
| HTTP route, OpenAPI schema, generated SDK, or internal Web API call                              | `change-server-api`                                |
| Durable storage, schema, index, migration, or recovery                                           | `change-persistence`                               |
| Capability, permission, control-profile, enforcement, or sandbox behavior                        | `change-execution-boundaries`                      |
| Browser ownership/control, Desktop native presentation, or WebRTC                                | `change-browser-runtime`                           |
| Plugin manifest, install/update, runtime, bridge, marketplace, or UI host                        | `change-plugin-runtime`                            |
| Built-in agent, CLI command, or first-party tool                                                 | `add-agent`, `add-cli-command`, or `add-tool`      |
| Test selection, isolated runtime, or Git operation                                               | `testing-guide`, `develop-synergy`, or `git-guide` |

When implementation or review reveals a reusable required pattern, registration, safety constraint, or verification step, update the owning Skill in the same change. Create a focused verb-led Skill if no existing workflow would reliably trigger. Root and package `AGENTS.md` files retain safety, global invariants, and routing; canonical docs retain product and architecture truth; Skills retain the executable procedure.

## Area-Specific Checks

- Server route/schema: regenerate SDK, typecheck runtime and SDK, run affected route tests.
- Session/message loop: read the session and frontend-sync contracts, run focused session tests, then shared checks.
- Frontend: typecheck `packages/app`, run relevant UI tests, preserve generated SDK usage and `PRODUCT.md` principles.
- Desktop/release: run Desktop typecheck/tests/build validation and review the Desktop release runbook.
- Plugin/public package: build package, run `package:check`, and verify exported ESM/type paths.
- Config/auth examples: run secret scanning and verify both global and project configuration behavior.
