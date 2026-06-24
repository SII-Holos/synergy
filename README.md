# Synergy <a href="https://www.sii.edu.cn" target="_blank" rel="noopener noreferrer"><img src=".github/assets/sii-logo.png" height="28" alt="Shanghai Innovation Institute" /></a>

Synergy is an AI agent platform for software work, built by the [Holos](https://github.com/SII-Holos) team at SII.

It combines a stateless server, browser-based and CLI workflows, configurable agents, persistent sessions, scheduled automation, and a growing set of knowledge and collaboration features. Synergy is not just a coding bot: it powers server runtime, Web, `send`, session workflows, agent orchestration, channel integrations, MCP connectivity, and product-facing automation — all from a single platform.

Synergy is open source under the [MIT License](LICENSE). Contributions, bug reports, and feature ideas are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) to get started.

## AI And LLM Entry Points

If you are an external coding agent or LLM tool reading this repository, start with [llms.txt](llms.txt). It routes plugin authors, source contributors, and architecture readers to the right documents.

Plugin authors do not need to clone this repository or read `AGENTS.md`. Use the installed Synergy CLI, `@ericsanchezok/synergy-plugin`, and the plugin authoring docs:

- [docs/plugins/agent-quickstart.md](docs/plugins/agent-quickstart.md)
- [docs/plugins/development-kit.md](docs/plugins/development-kit.md)
- [packages/plugin/README.md](packages/plugin/README.md)

Only read [AGENTS.md](AGENTS.md) when you are modifying Synergy source code.

---

### About Shanghai Innovation Institute

**Shanghai Innovation Institute (SII / 上海创智学院)** is a research institute dedicated to AI and large model innovation, based in Shanghai. The Holos team at SII builds Synergy as part of its open-source AI platform work.

🌐 [https://www.sii.edu.cn](https://www.sii.edu.cn)

---

## What Synergy Includes

Synergy currently spans several product surfaces and workflows:

- A central `server` process that handles requests independently of a single working directory
- A `web` client for browser-based interaction
- A built-in Browser workspace backed by Playwright/Chromium for interactive page control
- A `send` command for one-off, non-interactive execution
- CLI commands for session, config, identity, and operational workflows
- Configurable agents for orchestration, coding, research, writing, search, and review
- Session persistence and session management commands
- MCP integration for external tool ecosystems
- Channel integrations such as Feishu / Lark
- Identity, login, notes, memory/engram, agenda, and community-facing capabilities

### Built-In Browser Workspace

The Web client includes a right-side Browser workspace that runs a real Playwright Chromium page, not an iframe or a screenshot-only mock. Users can navigate, search, click, type, scroll, upload, and download in the workspace while browser tools operate on the same underlying page and BrowserContext.

Browser contexts are isolated by Synergy owner/session and persist tab state plus browser storage state. User-explicit navigation and page interaction run without approval prompts but still pass hard safety checks such as invalid protocols, sensitive local ports, and out-of-scope `file://` access. Agent-driven browser tools continue to use the active control profile, so guarded/autonomous/full-access behavior remains consistent with the rest of Synergy.

Large browser diagnostics such as console, network, snapshots, assets, and downloads are surfaced in the Browser workspace developer drawer and compact tool cards instead of flooding the normal chat transcript.

### Session History, File Restore, And Forking

Undo and redo operate on message history only. A rollback hides the latest effective user turn(s) from the session history used by the UI, model invocation, summaries, engram recall, and session forks; it does not restore, delete, or otherwise modify local files.

File restoration is an explicit follow-up action. When a rolled-back turn contains patch data, Synergy can restore selected files through the file restore endpoint or Web command. This is the only user-facing flow that applies snapshot patch data back to the workspace.

Forking copies the current effective history by default, so rolled-back turns are excluded. Forked sessions record their source in `forkedFrom` and do not use `parentID`, which remains reserved for background/subagent lineage. Forks can keep the current workspace or bind to a worktree when the calling surface requests it.

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

The installer places the runtime binary together with the bundled Web UI and schema assets under `~/.synergy/`, so `synergy web` works without requiring a local source checkout.

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
synergy stop
synergy logs
```

Background service management currently supports:

- macOS via `launchd`
- Linux via `systemd --user`
- Windows via `schtasks`

`synergy start`, `synergy status`, `synergy stop`, and `synergy logs` print a compact terminal summary with the service state, server URL, log file location, and suggested next commands. The managed service keeps structured logs in the daemon log file instead of mixing them into the startup UI. For foreground debugging, use `synergy server --print-logs` when you want live structured logs alongside the startup summary.

On Linux, user services usually require a working user manager session. To keep the service alive across logout, enable lingering with:

```bash
loginctl enable-linger "$USER"
```

### Running from this repository

One command to set up everything — deps, SDK, frontend, and sandbox helper:

```bash
bun dev prepare    # install deps, generate SDK, build frontend, compile sandbox helper
bun dev server     # start the server
```

Then connect from another terminal:

```bash
bun dev web --dev
bun dev send "hello"
```

After editing code:

```bash
bun dev build       # rebuild frontend (after app changes)
bun dev server      # restart the server
```

### Core runtime

```bash
synergy start                  # Start the background service, optionally with Holos login
synergy stop                   # Stop the background service
synergy stop && synergy start  # Restart the background service (stop + start)
synergy status                 # Show background service status
synergy doctor                 # Diagnose sandbox and environment readiness
synergy server                 # Start the Synergy server in foreground mode
synergy web                    # Open the web UI and attach to a server
synergy send "message"         # Run a one-off prompt
```

### Configuration and identity

```bash
synergy config              # Manage configuration
synergy config path         # Show config paths
synergy config import       # Import selected config domains
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

Synergy provides two built-in primary orchestrators: `synergy` for the classic general workflow and `synergy-max` for the expanded coding-harness workflow. Each primary agent sees a different built-in subagent set through agent visibility masks.

Classic subagents visible to `synergy` include `developer`, `explore`, `scout`, `advisor`, `inspector`, `scribe`, and `scholar`.

Core `synergy-max` subagent groups include:

- Task understanding: `intent-analyst`, `requirements-engineer`
- Code understanding: `code-cartographer`, `dependency-tracer`
- Design: `solution-architect`, `api-contract-designer`, `migration-architect`
- TDD: `test-strategist`, `regression-reproducer`, `fixture-builder`, `property-test-engineer`, `type-test-engineer`
- Execution: `implementation-engineer`, `refactoring-engineer`, `integration-engineer`, `documentation-engineer`
- Quality gates: `quality-gatekeeper`, `python-quality-engineer`, `rust-quality-engineer`, `typescript-quality-engineer`
- Reviews: `maintainability-reviewer`, `security-reviewer`, `performance-reviewer`, `api-compatibility-reviewer`, `documentation-reviewer`
- External and internal knowledge: `research-scout`, `docs-researcher`, `literature-searcher`, `literature-analyst`, `research-methodologist`, `memory-curator`, `note-librarian`, `session-historian`
- Continuity: `anima` for background maintenance roles

If you update agent names, roles, or recommended usage, update this section and `AGENTS.md` together.

## Configuration

Synergy configuration is layered and domain-based.

### Global config

Global config is loaded from one canonical domain directory:

```bash
~/.synergy/config/synergy.d/
```

Useful command:

```bash
synergy config path
```

### Project config

Project-level config uses the same domain layout under:

```bash
<project>/.synergy/synergy.d/
```

Synergy also supports project-scoped extension directories under:

```bash
.synergy/
```

That scoped directory is where project-specific agents, commands, plugins, skills, and related assets may live.

### Plugins

Plugins are managed through the plugin toolchain and the `50-plugins.jsonc` config domain. Plugin authors should use the installed Synergy CLI and `@ericsanchezok/synergy-plugin`; a Synergy source checkout is only needed when changing the platform itself.

New plugins should use the object descriptor API from `@ericsanchezok/synergy-plugin`:

```bash
synergy plugin create my-plugin
cd my-plugin
bun install
synergy plugin validate --runtime-discovery
synergy plugin build
synergy plugin pack
```

Install local development plugins with `synergy plugin add file:///absolute/path/to/my-plugin`. The descriptor `id`, `plugin.json.name`, registry id, and approval id must match.

### Session commands

Synergy uses one command registry with two command kinds:

- **Prompt commands** expand a template and enter the normal conversation flow. Built-ins such as `/review` and project commands from `.synergy/command/*.md` are prompt commands.
- **Action commands** perform deterministic session/runtime actions. They can be shown in the session timeline, but they are marked as not prompt-visible and are excluded from future model history. `/worktree` is an action command.

Frontend-only shortcuts such as model selection or panel toggles can also use slash syntax, but they are UI actions rather than backend commands. The slash syntax is only an entry point; the command kind decides whether the action talks to the model.

Modules that implement deterministic behavior should register an action handler with the command framework. For example, the worktree implementation lives under `packages/synergy/src/project/`, while the shared command registry lives under `packages/synergy/src/command/`.

### Session worktrees

When you want to work on multiple features in the same Git repository at the same time, bind a Synergy session to a Git worktree. The session keeps the same Scope identity, but tools run from the session workspace instead of the main checkout.

Use this when:

- you want two sessions to edit the same repo without stepping on each other's files
- you want a separate branch for a task before asking an agent to implement it
- you want to review or test another branch in an isolated checkout

Do not use this for non-Git directories. Normal sessions still work there, but Git worktrees require a Git-backed Scope.

#### Commands

Run these commands in the session prompt:

```text
/worktree list
/worktree new add-rate-limit
/worktree enter add-rate-limit
/worktree status
/worktree leave
/worktree remove add-rate-limit --force
```

What they do:

- `/worktree list` — list all Git worktrees reported by `git worktree list --porcelain`, with Synergy metadata overlaid when available.
- `/worktree new <name>` — create a new branch and worktree, bind the current session to it, and run worktree setup if configured.
- `/worktree enter <name-or-id-or-branch-or-path>` — bind the current session to an existing worktree.
- `/worktree status` — show the current session workspace and whether it has uncommitted changes.
- `/worktree leave` — move the current session back to the main workspace. This does not delete the worktree.
- `/worktree remove <name-or-id> [--force]` — remove a worktree. Without `--force`, Synergy refuses to remove a dirty worktree.

After `/worktree new` or `/worktree enter`, the switch applies to subsequent session work. Agents see the current workspace in their environment block, and tools such as shell commands and file edits run from that workspace.

Worktree sessions treat the worktree as the active workspace boundary. File, search, attachment, and local shell tools route through Synergy's control profile gate before they run. In a worktree session, the original checkout and sibling worktrees are outside the active workspace unless the session is using `full_access`; those boundary checks are not skipped by allow-all or unattended execution.

Control profiles are configured in the permissions domain (`80-permissions.jsonc`):

```jsonc
{
  "controlProfile": "guarded",
  "agent": {
    "synergy-max": {
      "controlProfile": "autonomous",
    },
  },
}
```

**Precedence:** agent config `controlProfile` > top-level config `controlProfile` > default `guarded`.

Built-in profiles:

| Config value  | UI label    | Behavior                                                                                                                                                                               |
| ------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `guarded`     | Guarded     | Default protected mode. Auto-allows safe reads, workspace-local edits, and ordinary network lookups; asks before shell, external filesystem, identity, platform, or extension actions. |
| `autonomous`  | Autonomous  | Unattended mode. Never asks; allows low/medium-risk work and denies high-risk boundaries.                                                                                              |
| `full_access` | Full Access | Allows all tool requests without approval prompts or workspace sandboxing.                                                                                                             |

`full_access` is blocked in unattended execution mode. It is only available in attended sessions.

### Sandbox

Synergy sandboxes shell command execution at the OS level for security. Availability per platform:

| Platform | Backend                        | Installed         | Source-deploy        |
| -------- | ------------------------------ | ----------------- | -------------------- |
| macOS    | `sandbox-exec` (Seatbelt)      | ✅ Out of the box | ✅ `bun dev prepare` |
| Linux    | `bwrap` + Rust helper          | ✅ Out of the box | ✅ `bun dev prepare` |
| Windows  | Restricted Token (Rust helper) | ✅ Out of the box | ✅ `bun dev prepare` |

> **Permission system** (profiles, ExecPolicy, approval gating) is pure TypeScript — works on all three platforms with zero setup, both installed and source-deploy.

Sandbox mode is driven by the active control profile (`guarded`, `autonomous`, `full_access`), not by global config. The built-in profiles resolve sandbox as follows:

| Profile       | Sandbox mode      | Fallback |
| ------------- | ----------------- | -------- |
| `guarded`     | `workspace_write` | `warn`   |
| `autonomous`  | `workspace_write` | `warn`   |
| `full_access` | `none`            | `allow`  |

The global `sandbox` config fields control backend selection and fallback behavior:

```jsonc
{
  "sandbox": {
    "enabled": true, // Enable/disable sandbox globally (default: true)
    "fallbackPolicy": "warn", // "warn" | "allow" | "deny" — when backend is unavailable (default: "warn")
    "backend": "auto", // Force a specific backend: "auto" (platform default),
    // "seatbelt-deny-default" (macOS deny-default SBPL),
    // "seatbelt-legacy-allow-default" (macOS allow-default SBPL),
    // "synergy-sandbox-linux" (Linux bundled bwrap),
    // "bwrap-inline-debug" (Linux in-tree bwrap debug),
    // "windows-restricted-token" (Windows MVP),
    // "windows-elevated" (Windows full, future)
    "network": {
      "mode": "restricted", // "restricted" | "proxy_only" | "full" — network access within sandbox
    },
    "macos": {
      "denialLogger": true, // Log sandbox denials via macOS Seatbelt (default: true)
    },
    "linux": {
      "bundledBwrap": true, // Use bundled bwrap binary instead of system bwrap (default: true)
      "landlockFallback": true, // Fall back to Landlock LSM when bwrap is unavailable (default: true)
    },
    "windows": {
      "level": "restricted-token", // "disabled" | "restricted-token" | "elevated"
      "helperPath": "/path/to/synergy-sandbox-windows.exe",
      "verifyHelperHash": true, // Verify helper binary SHA-256 hash before use (default: true)
      "privateDesktop": true, // Create a private desktop for sandboxed process (default: true)
      "conpty": true, // Use ConPTY for pseudo-terminal support (default: true)
    },
  },
}
```

#### Where Synergy stores worktrees

Synergy-created worktrees live inside the project:

```bash
.synergy/worktrees/
```

Synergy writes metadata under:

```bash
.synergy/worktrees/.registry/
```

Git remains the source of truth for existence. If a worktree exists in Git but has no Synergy metadata, it appears as external and can still be entered.

#### Setup for new worktrees

Worktrees are fresh checkouts. They do not automatically inherit ignored files such as `.env.local`, nor do they share dependencies. If a project needs setup, add a project-local setup file:

```jsonc
// .synergy/worktree-setup.jsonc
{
  "copyIgnored": [".env.local"],
  "setup": ["bun install"],
  "env": {
    "NODE_ENV": "development",
  },
}
```

For machine-specific setup, use the local override:

```bash
.synergy/worktree-setup.local.jsonc
```

Setup commands run inside the new worktree with these environment variables:

- `ROOT_WORKTREE_PATH` — the main repository checkout
- `WORKTREE_PATH` — the new worktree path
- `WORKTREE_NAME` — the generated worktree name
- `WORKTREE_BRANCH` — the generated branch name
- `SYNERGY_SCOPE_ID` — the current Scope ID

Only use setup files in repositories you trust. They run local shell commands when `/worktree new` creates a worktree.

#### Notes and cleanup

- New sessions still start in the main workspace by default. Worktree binding is explicit through `/worktree` commands.
- Child sessions inherit the parent session's current workspace.
- `/worktree leave` only unbinds the session; it does not remove files.
- Session archive/delete detaches Synergy metadata from the worktree, but dirty or externally managed worktrees are not automatically deleted.
- Synergy does not symlink dependency folders by default. Prefer package-manager caches (`bun`, `pnpm`, `uv`) over sharing `node_modules` across worktrees.

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

## Development

### Prerequisites

- [Bun](https://bun.sh) ≥ 1.3 (the repo pins `bun@1.3.11` via `packageManager`)

```bash
git clone https://github.com/SII-Holos/synergy.git
cd synergy
bun install
```

### Running locally

One command sets up everything: dependencies, SDK, frontend, and sandbox helper.

```bash
bun dev prepare
bun dev server
```

`bun dev prepare` handles the full stack — on macOS the sandbox works immediately (built-in `sandbox-exec`). On Linux and Windows it compiles the Rust sandbox helper automatically (requires `cargo` — install from https://rustup.rs if missing).

If Rust is not installed, prepare skips the sandbox step with a clear message and link. Re-run after installing Rust to complete sandbox setup.

### Sandbox setup details

`bun dev prepare` compiles the sandbox helper on Linux and Windows automatically. If you need to recompile it separately:

**Linux:** `cd packages/synergy/src/sandbox/helper-linux && cargo build --release`
**Windows:** `cd packages/synergy/src/sandbox/helper && cargo build --release`

Synergy auto-discovers the locally-built binary on startup. If the hash table is empty (pre-release state), the helper is still usable — Synergy runs minimum plausibility checks (file size, executable permission) instead of precise SHA-256 verification.

### Quality checks

```bash
bun run typecheck       # type-check all packages via turbo
./script/format.ts      # format with prettier
```

### Tests

Run TS tests from `packages/synergy` — the root `test` script intentionally blocks:

```bash
cd packages/synergy
bun test                                # full suite
bun test test/sandbox/                  # sandbox tests
bun test test/tool/read.test.ts         # single file
bun test --watch                        # watch mode
```

Run Rust helper tests:

```bash
cd packages/synergy/src/sandbox/helper-linux && cargo test   # Linux helper
cd packages/synergy/src/sandbox/helper && cargo test         # Windows helper
```

### Build and SDK generation

```bash
./packages/synergy/script/build.ts --single   # build the synergy CLI binary
bun dev prepare                                # regenerate SDK + rebuild frontend
```

Regenerate the SDK after modifying server routes or route schemas.

## Documentation Rules
