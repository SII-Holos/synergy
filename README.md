# Synergy <a href="https://www.sii.edu.cn" target="_blank" rel="noopener noreferrer"><img src=".github/assets/sii-logo.png" height="28" alt="Shanghai Innovation Institute" /></a>

Synergy is an AI agent platform for software work, built by the [Holos](https://github.com/SII-Holos) team at SII.

It combines a stateless server, browser-based and CLI workflows, configurable agents, persistent sessions, scheduled automation, and a growing set of knowledge and collaboration features. Synergy is not just a coding bot: it powers server runtime, Web, `send`, session workflows, agent orchestration, channel integrations, MCP connectivity, and product-facing automation — all from a single platform.

Synergy is open source under the [MIT License](LICENSE). Contributions, bug reports, and feature ideas are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) to get started.

---

### About Shanghai Innovation Institute

**Shanghai Innovation Institute (SII / 上海创智学院)** is a research institute dedicated to AI and large model innovation, based in Shanghai. The Holos team at SII builds Synergy as part of its open-source AI platform work.

🌐 [https://www.sii.edu.cn](https://www.sii.edu.cn)

---

## What Synergy Includes

Synergy currently spans several product surfaces and workflows:

- A central `server` process that handles requests independently of a single working directory
- A `web` client for browser-based interaction
- A `send` command for one-off, non-interactive execution
- CLI commands for session, config, identity, and operational workflows
- Configurable agents for orchestration, coding, research, writing, search, and review
- Session persistence and session management commands
- MCP integration for external tool ecosystems
- Channel integrations such as Feishu / Lark
- Identity, login, notes, memory/engram, agenda, and community-facing capabilities

## Quick Start

### Install

Install the latest bundled release:

```bash
curl -fsSL https://raw.githubusercontent.com/SII-Holos/synergy/main/install | bash
```

Install a specific version:

```bash
curl -fsSL https://raw.githubusercontent.com/SII-Holos/synergy/main/install | bash -s -- --version 1.2.2
```

The installer places the runtime binary together with the bundled Web UI, Config UI, and schema assets under `~/.synergy/`, so `synergy web` and `synergy config ui` work without requiring a local source checkout.

### If you already have the CLI installed

Start the background service first:

```bash
synergy start
```

`synergy start` launches the managed background service. If you want to connect Holos, do it from the Web UI or run `synergy login` separately.

For foreground debugging, you can still run:

```bash
synergy server
```

Then connect from another terminal:

```bash
synergy web
# or
synergy send "summarize the repo"
```

Attach to a non-default server when needed:

```bash
synergy web --attach http://localhost:5000
synergy send --attach http://localhost:5000 "run the task"
```

Inspect or manage the background service when needed:

```bash
synergy status
synergy restart
synergy stop
synergy logs
```

Background service management currently supports:

- macOS via `launchd`
- Linux via `systemd --user`
- Windows via `schtasks`

`synergy status` shows whether a managed service is installed, what runtime state is currently observed, and when the installed service differs from your current config. `synergy logs` shows the daemon log file, following the installed service path when it differs from the current config.

Start and restart print a fuller summary, including the supervisor in use, the server URL, log file location, and suggested next commands.

On Linux, user services usually require a working user manager session. To keep the service alive across logout, enable lingering with:

```bash
loginctl enable-linger "$USER"
```

### Running from this repository

Install dependencies, build the SDK, then build the frontend:

```bash
bun install
bun run --cwd packages/sdk/js build
bun run --cwd packages/app build
```

Start the server:

```bash
bun dev
```

Then connect from another terminal:

```bash
bun dev web --dev
bun dev send "hello"
```

## Common Commands

### Core runtime

```bash
synergy start              # Start the background service, optionally with Holos login
synergy stop               # Stop the background service
synergy restart            # Restart the background service
synergy status             # Show background service status
synergy server             # Start the Synergy server in foreground mode
synergy web                # Open the web UI and attach to a server
synergy send "message"     # Run a one-off prompt
```

### Configuration and identity

```bash
synergy config              # Manage configuration
synergy config path         # Show config paths
synergy config edit         # Open global config in an editor
synergy login               # Bind to Holos platform
synergy identity            # Work with identity-related features
```

### Models, sessions, and exports

```bash
synergy models              # List available models
synergy session list        # List sessions
synergy export <sessionID>  # Export session data
synergy import <file>       # Import session data
```

### Integrations

```bash
synergy mcp                 # Manage MCP servers
synergy channel add         # Add a channel configuration
synergy channel start       # Start configured channels
synergy channel status      # Show channel status
```

## Current Agent Model

Synergy uses a broad agent system with specialized roles.

Core built-in agents include:

- `synergy` for orchestration, planning, coordination, and multi-step work
- `master` for direct implementation and coding tasks
- `scholar` for academic and research-heavy tasks
- `scribe` for writing and documentation
- `explore` for codebase exploration
- `scout` for external technical documentation and open-source search
- `advisor` for architecture and review
- `anima` for background continuity and autonomous maintenance roles

If you update agent names, roles, or recommended usage, update this section and `AGENTS.md` together.

## Configuration

Synergy configuration is layered.

### Global config

The active global Config Set is loaded from `~/.synergy/config`.

By default, the `default` Config Set uses:

```bash
~/.synergy/config/synergy.jsonc
```

Additional global Config Sets live under:

```bash
~/.synergy/config/config-sets/<name>/synergy.jsonc
```

Useful command:

```bash
synergy config path
```

### Project config

Project-level config can be provided in the project tree, typically via:

```bash
synergy.jsonc
synergy.json
```

Synergy also supports project-scoped extension directories under:

```bash
.synergy/
```

That scoped directory is where project-specific agents, commands, plugins, skills, and related assets may live.

### Resolution order

At a high level:

- well-known / remote org config can provide defaults
- global config overrides those defaults
- explicit custom config paths can override global config
- project config has the highest local precedence
- `SYNERGY_CONFIG_CONTENT` can inject config at runtime

Do not document configuration examples from memory when they involve provider-specific fields or active integrations. Verify them against the current implementation before updating docs.

## Package Map

This repository is a Bun monorepo.

### Primary packages

- `packages/synergy` — core runtime, server, agent system, CLI, tools, sessions, permissions, integrations
- `packages/app` — main web application
- `packages/config-ui` — dedicated configuration UI package
- `packages/plugin` — plugin SDK published as `@ericsanchezok/synergy-plugin` (see `packages/plugin/README.md` for plugin authoring)
- `packages/sdk/js` — TypeScript SDK published as `@ericsanchezok/synergy-sdk`
- `packages/ui` — shared UI components
- `packages/util` — shared utilities and common helpers
- `packages/script` — build and release utilities
- `packages/meta-synergy` — companion CLI for connecting to remote Synergy hosts (see below)

## MetaSynergy (Experimental)

MetaSynergy is a lightweight companion CLI that connects to a remote Synergy host — useful when you want to use Synergy as a backend service without running the full local runtime.

> ⚠️ MetaSynergy is experimental. The API, behavior, and release artifacts may change without notice.

### Install

```bash
curl -fsSL https://raw.githubusercontent.com/SII-Holos/synergy/main/packages/meta-synergy/install | bash
```

Install a specific version:

```bash
curl -fsSL https://raw.githubusercontent.com/SII-Holos/synergy/main/packages/meta-synergy/install | bash -s -- --version 1.1.26
```

The installer places the binary under `~/.meta-synergy/bin/` and optionally adds it to your `PATH`.

## Hosted Deployment

Synergy can run as a hosted backend container while the Web UI is served separately from static hosting such as S3 and CloudFront.

Build the hosted frontend with explicit environment flags:

```bash
VITE_SYNERGY_HOSTED=1 \
VITE_SYNERGY_ALLOW_DEBUG_URL=0 \
VITE_SYNERGY_CONTROL_API_BASE=https://api.holosai.io \
bun run --cwd packages/app build
```

Use `VITE_SYNERGY_ALLOW_DEBUG_URL=1` only for test builds where `?url=` backend overrides are intended.

Build the hosted backend image:

```bash
docker build -f Dockerfile.hosted -t synergy-hosted:latest .
```

Hosted backend containers should receive owner and auth configuration from the control plane:

```bash
SYNERGY_HOSTED=1
SYNERGY_SCOPE_ROOT=/workspace
SYNERGY_DISABLE_WEB_MOUNT=1
SYNERGY_AUTH_COOKIE_NAME=holos_jwt
SYNERGY_JWT_SECRET=...
SYNERGY_JWT_ISSUER=...
SYNERGY_JWT_AUDIENCE=...
HOLOS_OWNER_ID=...
```

`SYNERGY_SCOPE_ROOT` defaults to `/workspace`, and `SYNERGY_AUTH_COOKIE_NAME` defaults to `holos_jwt`.
`SYNERGY_JWT_ISSUER` and `SYNERGY_JWT_AUDIENCE` are optional but recommended when the JWT secret is shared with other Holos services.

In hosted mode, the server defaults scope resolution to `SYNERGY_SCOPE_ROOT`, rejects directories outside that root, and validates `holos_jwt` itself before serving non-health API requests.

## Development

### Prerequisites

- [Bun](https://bun.sh) ≥ 1.3 (the repo pins `bun@1.3.11` via `packageManager`)

```bash
git clone https://github.com/SII-Holos/synergy.git
cd synergy
bun install
```

### Running locally

**Build the SDK** (required before building the frontend — `dist/` is not committed to git):

```bash
bun run --cwd packages/sdk/js build
```

**Build the frontend** (required before first run):

```bash
bun run --cwd packages/app build
```

This produces static files in `packages/app/dist`. The server serves them automatically.

**Start the server:**

```bash
bun dev
```

**Web UI (development mode)** — run in a second terminal while the server is up:

```bash
bun dev web --dev
```

This launches a Vite dev server for the frontend with hot-reload. Use this when working on the Web UI — no need to rebuild `packages/app/dist` each time.

**One-off prompt** — send a single message without opening the Web UI:

```bash
bun dev send "hello"
```

### Quality checks

```bash
bun run typecheck       # type-check all packages via turbo
./script/format.ts      # format with prettier
```

### Tests

Run tests from `packages/synergy` — the root `test` script intentionally blocks:

```bash
cd packages/synergy
bun test                            # full suite
bun test test/tool/read.test.ts     # single file
bun test --watch                    # watch mode
```

### Build and SDK generation

```bash
./packages/synergy/script/build.ts --single   # build the synergy CLI binary
./script/generate.ts                           # regenerate the TypeScript SDK
```

Regenerate the SDK after modifying server routes or route schemas.

## Documentation Rules

This repository moves quickly. README drift is a real maintenance issue.

Update documentation whenever you change:

- CLI command names or recommended command flows
- agent names, default roles, or user-facing descriptions
- config paths or config schema expectations
- package responsibilities in the monorepo
- user-facing platform features such as MCP, channels, identity, web flows, agenda, notes, or community features

If a change is visible to a user or another developer, it probably deserves a doc check.
