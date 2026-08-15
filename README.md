<div align="center">
  <a href="https://synergy.holosai.io">
    <img src="packages/ui/src/assets/brand/synergy-product-icon.png" width="112" alt="Synergy" />
  </a>

  <h1>Synergy</h1>

  <p><strong>Persistent, recoverable AI agent work.</strong></p>

  <p>
    An open-source workspace for software and knowledge work that keeps sessions, agents, files, Browser, tools, and automation connected in one runtime.
  </p>

  <p>
    <a href="https://synergy.holosai.io">Website</a> · <a href="docs/README.md">Documentation</a> · <a href="#quick-start">Quick Start</a> · <a href="CONTRIBUTING.md">Contributing</a>
  </p>

  <p>
    <a href="https://github.com/SII-Holos/synergy/releases/latest"><img src="https://img.shields.io/github/v/release/SII-Holos/synergy?sort=semver" alt="Latest release" /></a> <a href="https://github.com/SII-Holos/synergy/actions/workflows/ci.yml"><img src="https://github.com/SII-Holos/synergy/actions/workflows/ci.yml/badge.svg?branch=dev" alt="CI status" /></a> <a href="LICENSE"><img src="https://img.shields.io/github/license/SII-Holos/synergy" alt="MIT License" /></a>
  </p>

<sub>Built by the <a href="https://github.com/SII-Holos">Holos</a> team at [Shanghai Innovation Institute](https://www.sii.edu.cn).</sub>

  <p align="center">
    <a href=".github/assets/readme/synergy-workspace.png">
      <img src=".github/assets/readme/synergy-workspace.png" alt="Synergy workspace" width="100%" />
    </a>
  </p>

</div>

## Work that continues

AI agent work often outlives a single conversation. Synergy treats it as durable workspace state. A task can move between Web, Desktop, CLI, background execution, and specialist agents while preserving its project, history, files, tools, and operating context.

Synergy runs as a standalone local workspace. Connecting a Holos agent adds account identity, messaging, presence, and Synergy Link remote execution without replacing local projects, providers, sessions, or data.

## What makes Synergy different

- **Durable by default** — Keep recoverable sessions attached to an explicit home or project Scope, with complete history even when older model context is compacted.
- **One runtime, every surface** — Use the same sessions and state from the Web workbench, Desktop app, CLI, server API, and SDK.
- **First-class agent coordination** — Delegate to specialist subagents, plan durable Blueprints, run independently reviewed BlueprintLoops, keep focused work moving with Light Loop, or orchestrate a tree of persistent specialist workers with Boss Mode.
- **Files and Browser stay in context** — Work across project files and a session-owned Browser page without moving the task into a separate tool or disposable environment.
- **Knowledge compounds** — Retain reusable memory and learned experience in Library while authoring Notes and Blueprints as durable documents.
- **Local-first and extensible** — Add providers, tools, Skills, commands, MCP servers, plugins, Channels, and remote Synergy Link targets while keeping local ownership of projects and data.

Read the [product overview](docs/product/overview.md) for the complete product model, including Lattice Pathways, Agenda, Channels, Library, Holos, and extension boundaries.

## Quick Start

### Desktop

Download the latest installer from [GitHub Releases](https://github.com/SII-Holos/synergy/releases/latest). Desktop installers include the app and expose the packaged runtime as the `synergy` CLI.

| Platform | Installer   |
| -------- | ----------- |
| macOS    | `.pkg`      |
| Windows  | NSIS `.exe` |
| Linux    | `.deb`      |

Portable artifacts are also published, but they do not configure a system CLI. Windows Desktop and CLI releases currently support x64.

### CLI and Web

Install the current release:

```bash
curl -fsSL https://raw.githubusercontent.com/SII-Holos/synergy/main/install | bash
```

Configure a model provider, start the background runtime, and open the Web client:

```bash
synergy config wizard
synergy start
synergy web
```

Run one task directly from the terminal:

```bash
synergy send "summarize this repository"
```

Useful runtime commands:

```bash
synergy status
synergy logs
synergy doctor
synergy stop
```

The CLI installer places the runtime, Web UI, and schema assets under `~/.synergy/`; setting `SYNERGY_HOME=/path` changes that root to `/path/.synergy/`. It does not install the Electron Desktop app.

You can keep one Synergy installation per channel — the standalone CLI, a supported package-manager install (`npm`, `yarn`, `pnpm`, or `bun`), and the Desktop app — but only one should be the `synergy` command your shell runs. `synergy doctor` lists every detected installation channel and exits nonzero when channels conflict or an installed version cannot be verified. The curl installer and the npm package postinstall warn about other channels they detect and never auto-uninstall them. Homebrew's `synergy` formula is unrelated to this project and is not detected or managed.

Upgrade with `synergy upgrade`, or install a specific version by passing `--version <version>` to the installer. When multiple channels are installed, `synergy upgrade` stops instead of guessing: rerun with `--method <npm|yarn|pnpm|bun|desktop|standalone>` to select an installed, healthy channel.

`synergy uninstall` keeps its existing defaults and removes data, cache, config, and state unless you pass `--keep-data` or `--keep-config`. To remove only one installation channel while preserving shared data, cache, config, and state, run `synergy uninstall --installation-only --method <channel>`; standalone removal deletes only installer-owned files under `~/.synergy/` and the exact shell PATH entries the installer wrote.

Headless Browser tools require Chromium. Run `synergy browser install` to install the verified managed version and `synergy browser doctor` to check readiness, or set `CHROMIUM_PATH` to a separately installed executable. Desktop Browser presentation uses Electron's bundled Chromium.

Holos is optional. Connect an agent from the Web account surface or run `synergy holos login`.

See the [CLI reference](docs/reference/cli.md), [configuration reference](docs/reference/configuration.md), and [release notes](https://github.com/SII-Holos/synergy/releases) for complete setup and runtime details.

## Product Surfaces

| Surface            | Purpose                                                                                                                               |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| Web                | Primary workbench for sessions, project files, Browser, Notes, Library, Agenda, plugins, settings, and operational views.             |
| Desktop            | Electron product with a managed packaged server, native Browser presentation, local folder selection, protocol handling, and updates. |
| CLI                | Runtime management, one-off `send` execution, configuration, sessions, integrations, diagnostics, and development workflows.          |
| Server API and SDK | Shared contract used by first-party clients and integrations.                                                                         |

## Develop Synergy

Synergy is a Bun monorepo using TypeScript ESM modules. The pinned package manager is declared in [`package.json`](package.json).

Prepare a source checkout:

```bash
bun dev prepare
```

Common development flows:

```bash
bun dev server
bun dev app --open
bun dev web
bun dev desktop
bun dev desktop --managed
bun dev send "your message"
```

Default local preflight:

```bash
bun run quality:quick
```

Core runtime tests run from `packages/synergy`:

```bash
cd packages/synergy
bun test
bun run test:ci # CI-equivalent sequential shards
```

Frontend package suites run through their standard scripts and are included in `bun run quality`:

```bash
bun run --cwd packages/app test
bun run --cwd packages/ui test
```

Browser capability or App bootstrap changes also verify the source boundary and a genuine non-loopback HTTP origin:

```bash
bun test --cwd packages/app test/testing/browser-crypto-contract.test.ts
bun run --cwd packages/app build
bun packages/app/script/private-http-smoke.ts
```

Tests live under each package's `test/` directory; repository-level tests live under the root `test/` directory. `bun run quality:quick` enforces this layout.

Frontend product copy is extracted into English and Simplified Chinese catalogs, plus a development-only pseudo catalog. Changes to visible text or locale formatting also run:

```bash
bun run --cwd packages/app i18n:extract
bun run localization:check
```

When developing Synergy while using Synergy itself, start an isolated second instance with a separate `SYNERGY_HOME` and explicit ports. Never stop or replace the instance hosting your active session. The [development reference](docs/reference/development.md) contains the complete workflow.

## Develop Plugins

Plugin authors can start without cloning this repository:

```bash
bunx @ericsanchezok/synergy-plugin-kit create my-plugin --template tool-ui
cd my-plugin
bun install
synergy-plugin build
synergy-plugin validate --runtime-discovery
```

Start with the [plugin documentation](docs/plugins/README.md) and the [`@ericsanchezok/synergy-plugin` API reference](packages/plugin/README.md).

## Documentation

The [documentation home](docs/README.md) routes readers by product area and task.

- [Product overview](docs/product/overview.md) — product purpose, objects, workflows, and boundaries
- [Architecture](docs/architecture/README.md) — runtime invariants and implementation ownership
- [CLI reference](docs/reference/cli.md) — installed and source-checkout commands
- [Configuration reference](docs/reference/configuration.md) — domains, precedence, providers, and instructions
- [Storage and paths](docs/reference/storage-and-paths.md) — persistent state and workspace layout
- [Plugin documentation](docs/plugins/README.md) — definitions, generated artifacts, capabilities, runtime, UI, and publishing
- [Contributing](CONTRIBUTING.md) — repository setup and pull request workflow

Coding agents and LLM tools should begin with [llms.txt](llms.txt). Read [AGENTS.md](AGENTS.md) only when modifying the Synergy repository; plugin authors do not need the repository agent guide.

## About Shanghai Innovation Institute <a href="https://www.sii.edu.cn" target="_blank" rel="noopener noreferrer"><img src=".github/assets/sii-logo.png" height="28" alt="Shanghai Innovation Institute" /></a>

**Shanghai Innovation Institute (SII / 上海创智学院)** is a research institute dedicated to AI and large model innovation, based in Shanghai. The Holos team at SII builds Synergy as part of its open-source AI platform work.

🌐 [https://www.sii.edu.cn](https://www.sii.edu.cn)

## Contributing and Security

Contributions, bug reports, and feature ideas are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md), follow the [Code of Conduct](CODE_OF_CONDUCT.md), and use the repository's [security reporting process](.github/SECURITY.md) for vulnerabilities rather than opening a public issue.

Synergy is open source under the [MIT License](LICENSE).
