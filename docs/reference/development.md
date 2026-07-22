# Development Reference

Source development is orchestrated from the repository root with `bun dev`. The installed/product `synergy` CLI is a different surface.

## Requirements and Preparation

The root manifest pins Bun `1.3.14`. Install that version, then run:

```bash
bun dev prepare
```

Preparation installs dependencies, generates OpenAPI/SDK artifacts, builds the plugin SDK and Web app, and prepares the platform sandbox helper where supported. Linux and Windows helper compilation requires Rust; Linux sandboxing also uses Bubblewrap. `build-helper.ts --local` installs the local helper without editing tracked trust hashes. Stable builds compile each release helper first and embed its SHA-256 into the matching runtime binary.

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
| `web`               | source server, Vite app, and remote Browser Host                          |
| `desktop`           | source server, Vite app, and Electron in external-server mode             |
| `desktop --managed` | build plugin/app, then Electron with production-style managed server mode |
| `send`              | one-off source CLI execution                                              |

Use `--port` for standalone `server` and `app` modes. Use `--server-port`, `--app-port`, `--hostname`, and `--attach` for combined Web or Desktop flows. `--hostname` binds both the source server and Vite app in Web and external Desktop modes. The orchestrator checks required ports and target health before starting dependent processes. Parallel and serial modes terminate complete descendant process trees, including nested package scripts that create another process group, so stopping the orchestrator does not leave servers or Electron hosts running.

Managed Desktop rebuilds the Web distribution before launch so packaged-server behavior is not tested against stale frontend assets. Its server also watches the Electron parent and shuts down if Electron is force-terminated without running normal quit handlers. Normal daily Desktop work should use external mode for Vite reload speed.

The development orchestrator tags each spawned command so shutdown can recover descendant process groups after an intermediate package wrapper exits. Managed servers arm cross-platform parent-process liveness monitoring before startup work can report healthy.

### Terminal UI

The TUI is a client of an existing server; there is no separate `bun dev tui` orchestrator mode. Start the source server in one terminal:

```bash
bun dev server
```

Then run the TUI source in another terminal from the repository root:

```bash
bun -e 'import { runTui } from "./packages/tui/src/index.ts"; await runTui({ baseUrl: "http://127.0.0.1:4096", directory: process.cwd() })'
```

Use `synergy tui --attach http://127.0.0.1:4096` instead when testing the installed TUI package against the source server. Run TUI package checks with the commands in [Tests](#tests).

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
bun run test:ci
bun test test/tool/read.test.ts
bun run test:changed
bun run test:coverage
bun test --watch
```

`bun run test:ci` matches the CI core-suite boundary: four sequential shards run in separate Bun processes, limiting process-global state and temporary fixture accumulation while avoiding concurrent port and environment collisions. Set `SYNERGY_TEST_JUNIT_DIR` to a package-relative directory when per-shard JUnit reports are needed.

Provider/model tests use the pinned `test/tool/fixtures/models-api.json` catalog loaded by `test/preload.ts`. Update the fixture deliberately when a test requires a new model; do not reintroduce live model-catalog fetching into deterministic tests.

Other package tests can run through Turbo or their package scripts:

```bash
bun turbo test
bun run desktop:test
bun run --cwd packages/app test
bun run --cwd packages/ui test
bun run --cwd packages/tui test
bun run --cwd packages/tui typecheck
bun run --cwd packages/tui compile:smoke
```

Every test file lives under the owning package's `test/` directory; repository script and policy tests live under the root `test/` directory. Mirror source-domain subdirectories where useful, but never colocate `*.test.*` or `*.spec.*` beside implementation files. Run `bun run test-layout:check` to validate the repository boundary.

The App and shared UI package scripts are part of the Turbo test graph. The App runner isolates its production CSS build contract from ordinary unit tests. The UI runner executes ordinary suites together and isolates the session-turn timeline suite so its global module mocks cannot contaminate neighboring tests.

Theme source changes also regenerate the static boot fallback, Tailwind color mappings, and JSON schema from the canonical token catalog:

```bash
bun run --cwd packages/ui generate:theme
```

Frontend product colors must use the canonical semantic theme contract. Do not add Tailwind palette colors, arbitrary literal color utilities, or component-local light/dark palettes. See [Frontend themes and color](frontend-theming.md) for consumer rules, imperative renderer integration, semantic token changes, and the recommended plugin workflow for creating a selectable theme.

Localized frontend changes also update and validate the shared App/UI Lingui catalog:

```bash
bun run --cwd packages/app i18n:extract
bun run localization:check
```

`i18n:extract` is App-owned because `packages/app/lingui.config.ts` includes both `packages/app/src` and `packages/ui/src`. The single root `localization:check` gate re-extracts catalogs and rejects drift, rejects missing or blank Simplified Chinese translations, strictly compiles every locale, then enforces the App/UI source contract for hard-coded visible strings, Chinese source literals, hard-coded locale tags, invalid descriptors, dynamic IDs, and Lingui macro imports. Keep tracked PO catalogs unchanged after extraction before handing off a localization change.

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
bun run test-layout:check
bun run quality:quick
bun run quality
```

`quality:quick` is the default local PR preflight: format, lint, Skill/package-guide/test-layout checks, strict localization contract, typecheck, monorepo consistency, and package validation. `quality` adds all Turbo tests. The pre-push hook runs Bun-version, format, lint, typecheck, and monorepo checks; CI runs the wider matrix.

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

Repository changes may be made directly in the current checkout. Treat primary and pre-existing checkouts as potentially shared: preserve unrelated work, and do not switch branches or rebase unless the user explicitly requests it. Use a task-owned worktree when concurrent development needs branch or file isolation, not as a prerequisite for every edit, and reuse an existing task worktree when it already owns the branch.

Stage and commit only when requested. Local commits on `dev` or `main` are allowed, but never push either protected branch directly. Push a topic branch and open its pull request against `dev`; the release workflow is the only path from `dev` to `main`. Preserve unrelated changes, stage explicit task files, and keep local paths, runtime identifiers, logs, credentials, and internal configuration out of commit and GitHub text. See `git-guide` for the commit template, mandatory agent co-author footer, and publication workflow.

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
- Plugin/public package/TUI: build the package, run its focused tests and typecheck, run `package:check`, and verify exported ESM/type paths. TUI changes also run `compile:smoke` to exercise OpenTUI native loading in a compiled Bun executable.
- Config/auth examples: run secret scanning and verify both global and project configuration behavior.
