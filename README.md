# Synergy <a href="https://www.sii.edu.cn" target="_blank" rel="noopener noreferrer"><img src=".github/assets/sii-logo.png" height="28" alt="Shanghai Innovation Institute" /></a>

Synergy is an open-source AI agent workspace for persistent, recoverable software and knowledge work. It is built by the [Holos](https://github.com/SII-Holos) team at Shanghai Innovation Institute (SII).

One Synergy runtime hosts sessions, agents, tools, knowledge, automation, and integrations. Web, Desktop, and CLI are clients of that runtime, so the same work can continue across interactive, background, and one-off flows.

Synergy works as a standalone local workspace. Connecting a Holos agent adds account identity, agent messaging, presence, and Synergy Link remote execution without replacing local projects, providers, sessions, or data.

Read the [product overview](docs/product/overview.md) for the complete product model.

## What You Can Do

- Keep durable sessions attached to an explicit home or project `Scope`.
- Use configurable primary agents and specialist subagents with built-in, MCP, and plugin tools.
- Plan work as durable Blueprints, execute them through independently reviewed BlueprintLoops, or use Light Loop for a focused task that should continue until verified.
- Organize larger goals as a Lattice Pathway of planned, executed, and reviewed steps.
- Schedule recurring or triggered work through Agenda.
- Retain reusable memory and learned experience in Library, while authoring Notes and Blueprints as separate documents.
- Browse project files through the Side Workspace file workbench with a virtualized Explorer, multi-file tabs, and source or preview modes.
- Work with the same session-owned Browser page from the UI and browser tools.
- Connect external messaging through Channels, mail through governed Email tools, and remote agents or hosts through Holos and Synergy Link.
- Manage Clarus projects, task assignments, and project activity through the Holos agent tunnel.
- Extend tools, agents, skills, commands, MCP servers, configuration, hooks, and product UI with plugins.

Long sessions use compaction to replace older model context with a continuation summary while preserving the complete durable session history.

## Product Surfaces

| Surface            | Purpose                                                                                                                                    |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Web                | The primary workbench for sessions, project files, Browser, Notes, Library, Agenda, plugins, settings, and operational views.              |
| Desktop            | The Electron product, with a managed packaged server, native Browser presentation, local folder selection, protocol handling, and updates. |
| CLI                | Runtime management, one-off `send` execution, configuration, sessions, integrations, diagnostics, and development workflows.               |
| Server API and SDK | The shared contract used by first-party clients and integrations.                                                                          |

## Quick Start

### Desktop

Download a platform installer from [GitHub Releases](https://github.com/SII-Holos/synergy/releases):

- macOS: `.pkg`
- Windows: NSIS `.exe`
- Linux: `.deb`

The recommended installers include the Desktop app and expose its packaged runtime as the `synergy` CLI. Portable artifacts are also published but do not configure a system CLI.

### CLI and Web

Install the current release:

```bash
curl -fsSL https://raw.githubusercontent.com/SII-Holos/synergy/main/install | bash
```

Install a specific release:

```bash
curl -fsSL https://raw.githubusercontent.com/SII-Holos/synergy/main/install | bash -s -- --version <version>
```

The CLI installer places the runtime, Web UI, and schema assets under `~/.synergy/`. It does not install the Electron Desktop app.

Configure a model provider, start the background runtime, and open the Web client:

```bash
synergy config wizard
synergy start
synergy web
```

Run one task from the terminal:

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

Run `synergy server` for a foreground server. `synergy web --attach <url>` and `synergy send --attach <url> ...` connect to a non-default runtime.

Holos is optional. Connect an agent from the Web account surface or with:

```bash
synergy holos login
```

See the [CLI reference](docs/reference/cli.md) and [configuration reference](docs/reference/configuration.md) for the complete command and configuration models.

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
```

Frontend package suites run through their standard scripts and are included in `bun run quality`:

```bash
bun run --cwd packages/app test
bun run --cwd packages/ui test
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

## About Shanghai Innovation Institute

**Shanghai Innovation Institute (SII / 上海创智学院)** is a research institute dedicated to AI and large model innovation, based in Shanghai. The Holos team at SII builds Synergy as part of its open-source AI platform work.

🌐 [https://www.sii.edu.cn](https://www.sii.edu.cn)

## Contributing and Security

Contributions, bug reports, and feature ideas are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md), follow the [Code of Conduct](CODE_OF_CONDUCT.md), and use the repository's [security reporting process](.github/SECURITY.md) for vulnerabilities rather than opening a public issue.

Synergy is open source under the [MIT License](LICENSE).
