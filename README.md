# Synergy <a href="https://www.sii.edu.cn" target="_blank" rel="noopener noreferrer"><img src=".github/assets/sii-logo.png" height="28" alt="Shanghai Innovation Institute" /></a>

Synergy is an AI agent platform for software work, built by the [Holos](https://github.com/SII-Holos) team at SII.

It combines a stateless server, browser-based and CLI workflows, configurable agents, persistent sessions, scheduled automation, and a growing set of knowledge and collaboration features. Synergy is not just a coding bot: it powers server runtime, Web, `send`, session workflows, agent orchestration, channel integrations, MCP connectivity, and product-facing automation — all from a single platform.

Synergy is open source under the [MIT License](LICENSE). Contributions, bug reports, and feature ideas are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) to get started.

## AI And LLM Entry Points

If you are an external coding agent or LLM tool reading this repository, start with [llms.txt](llms.txt). It routes plugin authors, source contributors, and architecture readers to the right documents.

Plugin authors do not need to clone this repository or read `AGENTS.md`. Use `@ericsanchezok/synergy-plugin-kit`, `@ericsanchezok/synergy-plugin`, and the plugin authoring docs:

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

Synergy spans several product surfaces and workflows:

- A central `server` process that handles requests independently of a single working directory
- A `web` client for browser-based interaction
- A production desktop application that embeds and supervises a local Synergy server
- A built-in Browser workspace backed by Chromium, with shared control state for humans and browser tools
- A `send` command for one-off, non-interactive execution
- CLI commands for session, config, library, Holos identity, and operational workflows
- Configurable agents for orchestration, coding, research, writing, search, and review
- Session persistence and session management commands
- MCP integration for external tool ecosystems
- Channel integrations such as Feishu / Lark
- Holos identity, login, notes, library, agenda, and community-facing capabilities
- A Performance settings panel for local-first runtime health, request/session/tool latency, resource usage, frontend Web Vitals, and redacted trace drill-down

### Performance Observability

The Web Settings runtime area includes a first-class **Performance** panel for live local observability. It summarizes backend request latency and error rate, session/tool/LLM activity, CPU and memory pressure, event-loop lag, app-owned IO counters, frontend Web Vitals, long tasks, top slow owners, and active performance issues in one surface.

Performance data is collected locally and stored under `~/.synergy/state/observability/performance/performance.sqlite` with bounded retention. Raw Observability JSONL traces remain available for compatibility and support packages, while the Performance API exposes redacted metrics, spans, issues, timeline, and trace-detail projections under `/global/performance/*`. Diagnostics remains a hidden support API; Performance is the user-facing monitoring surface.

See [docs/performance-observability.md](docs/performance-observability.md) for the configuration fields, API routes, local storage layout, and optional OSS load/perf tooling commands.

### Built-In Browser Workspace

The Web client includes a right-side Browser workspace backed by real Chromium. Users can navigate, search, click, type, scroll, upload, and download in the workspace while browser tools operate on the same underlying session page.

Browser control and Browser presentation are intentionally separate. The shared control protocol owns the session page, navigation, screenshots, snapshots, diagnostics, downloads, dialogs, and tool actions. Interactive presentation has two modes: local desktop clients use an embedded Electron `WebContentsView`, and remote Web clients use WebRTC media plus input data channels. Browser Hosts register over the same control protocol so human UI and browser tools operate on the same visible page whenever a native or WebRTC host is attached.

The Browser server boundary follows the same split: session/control endpoints carry page state and commands, Browser Host control has its own route, and WebRTC signaling has its own route. Production interactive viewing uses native desktop presentation or WebRTC. Remote text, IME composition, paste, pointer, wheel, and shortcut input travel over the WebRTC data channel so the remote surface behaves like a local browser window.

Each Synergy session has at most one Browser page. Opening the Browser workspace reads the current session state and does not create a page. The first address-bar navigation or browser tool navigation creates the page; later navigation reuses that same page.

Remote WebRTC Browser Hosts autostart by default when a remote Browser viewer connects. Set `SYNERGY_BROWSER_HOST_AUTOSTART=0` to disable server-managed host startup, or set `SYNERGY_BROWSER_HOST_COMMAND` to provide a custom Electron host command.

Browser contexts are isolated by Synergy owner/session and persist page state plus browser storage state. User-explicit navigation and page interaction run without approval prompts but still pass hard safety checks such as invalid protocols, sensitive local ports, and out-of-scope `file://` access. Agent-driven browser tools continue to use the active control profile, so guarded/autonomous/full-access behavior remains consistent with the rest of Synergy.

Large browser diagnostics such as console, network, snapshots, assets, and downloads appear in the Browser workspace developer drawer and compact tool cards. The normal chat transcript stays focused on user-visible results.

### Desktop Application

`packages/desktop` is the Electron desktop product for Synergy. Its production identity is `io.holosai.synergy`, product name `Synergy`, desktop shell executable name `synergy-desktop`, public runtime CLI name `synergy`, and URL protocol `synergy://`.

Production desktop builds default to managed server mode: the app starts a packaged local Synergy server runtime, waits for `/global/health`, then loads the Web UI from the local server origin. Managed server failures show a desktop error page. Source-checkout desktop development uses `bun dev desktop`, which defaults to external mode against the local Vite app and Synergy server.

In managed desktop mode, Add/Open Project uses the operating system's native folder picker because the app and managed Synergy server share the same local filesystem. Web clients, remote servers, and desktop external-server mode use Synergy's server-directory browser so project paths always come from the server filesystem.

On Windows and Linux, closing the desktop window hides it to the Synergy system tray icon so the local server and session shell remain reopenable. Use the tray menu to reopen Synergy or quit the desktop process. macOS keeps the standard Dock activation behavior.

Desktop release artifacts are produced with `electron-builder` for macOS, Windows, and Linux and published through GitHub Releases. Recommended Desktop installers are macOS `.pkg`, Windows NSIS `.exe`, and Linux `.deb`; they install the Desktop app and expose the packaged runtime as the public `synergy` CLI. Portable artifacts such as `.dmg`, `.zip`, `.AppImage`, and `.tar.gz` remain available for updater, app-bundle, or debug workflows and do not modify PATH.

Stable desktop users can update without a terminal. The desktop shell checks for updates in the background, downloads according to the local desktop update mode, then offers `Restart to Update` in Settings and in the persistent sidebar update prompt; that action stops the managed server process, installs the Electron update, restarts the app, and starts the new bundled server runtime. Desktop-managed CLI updates follow the same Desktop updater path.

Web clients update frontend assets by refreshing the browser page when the loaded app version differs from `/global/health`; the sidebar prompt offers `Refresh` when that state is detected. Server replacement from Web is available only for a localhost Synergy managed daemon installed through a supported package manager. A normal terminal-run `synergy server` and a Desktop-managed runtime remain owned by their launch surface and are not replaced from the browser.

### Session History, File Restore, And Forking

Undo and redo operate on message history only. A rollback hides the latest effective user turn(s) from the session history used by the UI, model invocation, summaries, library recall, and session forks; it does not restore, delete, or otherwise modify local files.

File restoration is an explicit follow-up action. When a rolled-back turn contains patch data, Synergy can restore selected files through the file restore endpoint or Web command. This is the only user-facing flow that applies snapshot patch data back to the workspace.

Forking copies the current effective history by default, so rolled-back turns are excluded. Forked sessions record their source in `forkedFrom` and do not use `parentID`, which remains reserved for background/subagent lineage. Forks can keep the current workspace or bind to a worktree when the calling surface requests it.

## Quick Start

### Install

Recommended Desktop install:

Download the platform installer from GitHub Releases: macOS `.pkg`, Windows `.exe`, or Linux `.deb`. After installation, a new terminal can run both the Desktop-managed CLI and the app-managed runtime:

```bash
synergy --version
synergy start
synergy web
synergy send "summarize this repo"
synergy status
synergy doctor
```

The Desktop installer does not run the CLI installer, does not copy a second runtime, and does not edit shell rc files. It exposes the runtime already bundled inside the Desktop app. Portable Desktop artifacts do not modify PATH; use the recommended installer when you want the Desktop app and CLI together.

CLI + Web install:

```bash
curl -fsSL https://raw.githubusercontent.com/SII-Holos/synergy/main/install | bash
```

Install a specific CLI + Web version:

```bash
curl -fsSL https://raw.githubusercontent.com/SII-Holos/synergy/main/install | bash -s -- --version 2.4.3
```

The CLI + Web installer places the runtime binary together with the bundled Web UI and schema assets under `~/.synergy/`, so `synergy web` works without requiring a local source checkout. It does not install the Electron Desktop app.

### Develop Plugins

Plugin authors can create and publish plugins without installing the Synergy source tree:

```bash
bunx @ericsanchezok/synergy-plugin-kit create my-plugin --template tool-ui
cd my-plugin
bun install
synergy-plugin dev
synergy-plugin validate --runtime-discovery
synergy-plugin publish-market
```

`publish-market` builds, packs, signs, uploads GitHub Release assets when `gh` is available, prepares the official `SII-Holos/synergy-plugins` registry PR, and leaves clear manual steps when a GitHub action cannot be automated.

Plugin Web UI contributions can add tool and message rendering, session workbench panels, top-level sidebar app panels, settings sections, themes, icons, app routes, and command palette actions.

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

`synergy start`, `synergy status`, `synergy stop`, and `synergy logs` print a compact terminal summary with the service state, server URL, log file location, and suggested next commands. The managed service writes structured logs to the daemon log file. For foreground debugging, use `synergy server --print-logs` when you want live structured logs alongside the startup summary.

On Linux, user services usually require a working user manager session. To keep the service alive across logout, enable lingering with:

```bash
loginctl enable-linger "$USER"
```

### Running from this repository

Use `bun dev` as the source-checkout development orchestrator. It is intentionally separate from the installed/product `synergy` CLI.

```bash
bun dev prepare    # install deps, generate SDK, build frontend, compile sandbox helper
```

Common development flows:

```bash
bun dev server            # server only, fixed development port
bun dev app --open        # Vite web app against an existing server
bun dev web               # server + Vite web app
bun dev desktop           # server + Vite web app + Electron desktop shell
bun dev desktop --managed # rebuild Web app dist + Electron managed server mode
```

After editing code:

```bash
bun dev build app       # rebuild the web app
bun dev build desktop   # rebuild Electron main/preload
bun dev send "hello"    # run a one-off prompt from source
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

### Configuration, library, and Holos

```bash
synergy config              # Manage configuration
synergy config path         # Show config paths
synergy config import       # Import selected config domains
synergy library             # Manage library memory and learning
synergy holos login         # Bind to Holos platform
```

### Models, sessions, and exports

```bash
synergy models              # List available models
synergy models --refresh    # Refresh provider catalog, models.dev metadata, and live model discovery
synergy auth login          # Connect a model provider
synergy auth usage          # Show provider account usage and quota windows when available
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

## Agent Model

Synergy provides two built-in primary orchestrators: `synergy` for the classic general workflow and `synergy-max` for the expanded coding-harness workflow. Each primary agent sees a different built-in subagent set through agent visibility masks.

Classic subagents visible to `synergy` include `developer`, `explore`, `scout`, `advisor`, `inspector`, `scribe`, and `scholar`.

Core `synergy-max` subagent groups include:

- Task understanding: `intent-analyst`, `requirements-engineer`
- Code understanding: `code-cartographer`, `dependency-tracer`
- Design: `solution-architect`, `api-contract-designer`, `migration-architect`
- Verification: `test-strategist`, `fixture-builder`, `property-test-engineer`, `type-test-engineer`
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

The Web Settings UI uses the same canonical domains. Common settings are editable as forms, and low-frequency or nested domains can be opened directly from Settings with the system default editor.

### Project config

Project-level config uses the same domain layout under:

```bash
<project>/.synergy/synergy.d/
```

Synergy also supports project-scoped extension directories under:

```bash
.synergy/
```

That scoped directory is where project-specific agents, commands, plugins, skills, generated outputs, and related assets may live. Project `.synergy/**` and non-secret global `~/.synergy/**` areas are normal Synergy-managed configuration/output space; auth roots such as `~/.synergy/data/auth/**` remain protected.

### Provider authentication

Use `synergy auth login` or the Web UI's **Connect provider** dialog to connect model providers. Provider credentials are stored in Synergy's own credential file:

```bash
~/.synergy/data/auth/provider-auth.json
```

Synergy resolves providers from a built-in provider profile registry, an optional signed remote catalog, `models.dev` metadata, live model discovery, and user config overrides. The remote catalog is data-only and must verify with the configured Ed25519 public key before Synergy uses it; provider-specific auth and transport behavior comes from built-in code or explicitly installed plugins, not remote executable code.

`openai-codex` is the built-in OpenAI Codex provider for ChatGPT/Codex subscription login. It uses a ChatGPT/Codex device-code sign-in and the Codex backend, then exposes account-visible Codex models such as `gpt-5.4-mini` in `synergy models openai-codex` and the model picker. This is separate from the normal `openai` provider: OpenAI Platform API keys still use `openai` and follow Platform API billing.

Synergy also supports subscription-style provider profiles such as Claude Pro/Max OAuth, GitHub Copilot, MiniMax OAuth, and usage-aware providers such as OpenRouter. Run `synergy auth usage [provider]` to inspect quota or credit snapshots when a provider exposes a reliable endpoint. Providers without a reliable usage endpoint report usage as unavailable.

When `CODEX_HOME` or `~/.codex/auth.json` exists, the CLI can copy valid Codex CLI credentials into Synergy. Synergy does not share or write back to the Codex CLI auth file, so refresh-token rotation stays isolated between the two tools.

### Project instruction files

For every turn, Synergy includes instruction files discovered inside the active Scope. In each directory from the Scope root to the current working directory, it uses the first matching file in this order:

```text
AGENTS.override.md
AGENTS.md
<project_doc_fallback_filenames entries>
CLAUDE.md
CONTEXT.md
```

`AGENTS.override.md` is useful for local-only overrides. Configure fallback filenames, such as `PRODUCT.md` or `WORKFLOW.md`, in `60-agents.jsonc`:

```jsonc
{
  "project_doc_fallback_filenames": ["PRODUCT.md", "WORKFLOW.md"],
  "project_doc_max_bytes": 32768,
}
```

`instructions` remains the explicit include list for extra files, globs, or URLs; it appends content and does not participate in the fallback order.

### Plugins

Plugins are managed through the plugin toolchain and the `50-plugins.jsonc` config domain. Plugin authors should use `@ericsanchezok/synergy-plugin-kit` and `@ericsanchezok/synergy-plugin`; a Synergy source checkout is only needed when changing the platform itself.

New plugins should use the object descriptor API from `@ericsanchezok/synergy-plugin`:

```bash
bunx @ericsanchezok/synergy-plugin-kit create my-plugin
cd my-plugin
bun install
synergy-plugin dev
synergy-plugin validate --runtime-discovery
synergy-plugin publish-market
```

Install local development plugins with `synergy plugin add file:///absolute/path/to/my-plugin`. The descriptor `id`, `plugin.json.name`, registry id, and approval id must match.

Plugin Web UI contributions can add top-level sidebar app panels through `contributes.ui.appPanels`; session-specific side and bottom workspace surfaces use `contributes.ui.workbenchPanels`.

### Session commands

Synergy uses one command registry with two command kinds:

- **Prompt commands** expand a template and enter the normal conversation flow. Built-ins such as `/review` and project commands from `.synergy/command/*.md` are prompt commands.
- **Action commands** perform deterministic session/runtime actions. They can be shown in the session timeline, but they are marked as not prompt-visible and are excluded from future model history. `/worktree` is an action command.

Frontend-only shortcuts such as model selection or panel toggles can also use slash syntax. These UI actions do not enter the backend command registry or model prompt flow. The slash syntax is only an entry point; the command kind decides whether the action talks to the model.

Modules that implement deterministic behavior should register an action handler with the command framework. For example, the worktree implementation lives under `packages/synergy/src/project/`, while the shared command registry lives under `packages/synergy/src/command/`.

### Session worktrees

When you want to work on multiple features in the same Git repository at the same time, bind a Synergy session to a Git worktree. The session keeps the same Scope identity, and tools run from the session workspace.

Use this when:

- you want two sessions to edit the same repo without stepping on each other's files
- you want a separate branch for a task before asking an agent to implement it
- you want to review or test another branch in an isolated checkout

Use worktrees only for Git-backed Scopes. Normal sessions support non-Git directories.

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

Worktree sessions treat the worktree as the active workspace boundary. File, search, attachment, and local shell tools route through Synergy's control profile gate before they run. In a worktree session, the original checkout and sibling worktrees are outside the active workspace unless the active profile explicitly allows the operation; `full_access` is the author-at-own-risk profile that allows all permission-system capabilities without prompts.

Control profiles are configured in the permissions domain (`80-permissions.jsonc`):

```jsonc
{
  "controlProfile": "guarded",
  "smartAllow": false,
  "agent": {
    "synergy-max": {
      "controlProfile": "autonomous",
    },
  },
}
```

**Precedence:** explicit session control profile resolved from the session parent chain > agent config `controlProfile` > top-level config `controlProfile` > source default. Channel-backed and agenda automation root sessions default to `autonomous`; ordinary interactive/manual sessions default to `guarded`.

Explicit configuration is always honored. For example, a top-level `controlProfile: "full_access"` remains `full_access` for Feishu/channel sessions instead of being downgraded by unattended metadata.

Blueprint runs started from the Notes side panel use the current session's control profile when running in the current session. New-session and worktree Blueprint runs create an execution session with at least `autonomous`; a top-level `full_access` profile remains `full_access`.

`smartAllow` enables a hidden internal agent that can auto-allow high-confidence safe asks in `guarded` and eligible false-positive denies in `autonomous`. It receives only metadata or redacted file evidence for secret-like paths, never raw secret values. It does not run for `full_access`, and failed autonomous SmartAllow checks deny instead of prompting.

Risk levels follow the operation's effect. Ordinary reads, including non-protected external reads, are low risk. Revertible local edits, non-destructive shell commands, and network calls are medium risk. Protected paths, external writes, secrets, destructive shell commands, identity-affecting actions, and outbound communication are high risk.

Built-in profiles:

| Config value  | UI label    | Behavior                                                                                                                                                                                                                                                       |
| ------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `guarded`     | Guarded     | Manual-supervision profile. Auto-allows ordinary reads, workspace-local edits, ordinary network lookups, and non-secret `.synergy/**` operations; asks before operations that need human judgment when SmartAllow cannot safely auto-allow them.               |
| `autonomous`  | Autonomous  | Unattended automation profile. Never prompts the user: ordinary development work is allowed, eligible false-positive denies may be auto-allowed by SmartAllow at high confidence, and anything that cannot be allowed is denied with a policy diagnostic.      |
| `full_access` | Full Access | Author-at-own-risk profile. The permission system silently allows every capability, including protected paths, secrets, destructive or hardline shell commands, identity/channel actions, and external writes; non-permission failures still surface normally. |

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
      "bundledBwrap": true, // Prefer bundled bwrap binary (default: true)
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
- Synergy keeps dependency folders per worktree by default. Use package-manager caches (`bun`, `pnpm`, `uv`) for dependency reuse across worktrees.

### Resolution order

At a high level:

- well-known / remote org config can provide defaults
- global config overrides those defaults
- explicit custom config paths can override global config
- project config has the highest local precedence
- `SYNERGY_CONFIG_CONTENT` can inject config at runtime

Do not document configuration examples from memory when they involve provider-specific fields or active integrations. Verify them against the implementation before updating docs.

## Package Map

This repository is a Bun monorepo.

### Primary packages

- `packages/synergy` — core runtime, server, agent system, CLI, tools, sessions, permissions, integrations
- `packages/app` — main web application
- `packages/desktop` — Electron desktop application, managed local server host, packaging, updates
- `packages/plugin` — plugin SDK published as `@ericsanchezok/synergy-plugin` (see `packages/plugin/README.md` for plugin authoring)
- `packages/plugin-kit` — standalone plugin development CLI published as `@ericsanchezok/synergy-plugin-kit`
- `packages/sdk/js` — TypeScript SDK published as `@ericsanchezok/synergy-sdk`
- `packages/ui` — shared UI components
- `packages/util` — shared utilities and common helpers
- `packages/script` — build and release utilities
- `packages/synergy-link` — companion CLI for connecting to remote Synergy hosts (see below)

## Synergy Link (Experimental)

Synergy Link is a lightweight companion CLI that connects to a remote Synergy host — useful when you want to use Synergy as a backend service without running the full local runtime.

> ⚠️ Synergy Link is experimental. The API, behavior, and release artifacts may change without notice.

### Install

```bash
curl -fsSL https://raw.githubusercontent.com/SII-Holos/synergy/main/packages/synergy-link/install | bash
```

Install a specific version:

```bash
curl -fsSL https://raw.githubusercontent.com/SII-Holos/synergy/main/packages/synergy-link/install | bash -s -- --version 2.4.3
```

The installer places the binary under `~/.synergy-link/bin/` and optionally adds it to your `PATH`.

## Development

### Prerequisites

- [Bun](https://bun.sh) ≥ 1.3 (the repo pins `bun@1.3.14` via `packageManager`)

```bash
git clone https://github.com/SII-Holos/synergy.git
cd synergy
bun install
```

### Running locally

One command sets up everything: dependencies, SDK, frontend, and sandbox helper.

```bash
bun dev prepare
```

`bun dev prepare` handles the full stack — on macOS the sandbox works immediately (built-in `sandbox-exec`). On Linux and Windows it compiles the Rust sandbox helper automatically (requires `cargo` — install from https://rustup.rs if missing).

If Rust is not installed, prepare skips the sandbox step with a clear message and link. Re-run after installing Rust to complete sandbox setup.

Start the source development stack:

```bash
bun dev web       # server + Vite web app
bun dev desktop   # server + Vite web app + Electron desktop shell
```

### Desktop development

Run the desktop shell in the default external development mode:

```bash
bun dev desktop
```

Validate the production-style managed server path with a fresh Web app dist:

```bash
bun dev desktop --managed
```

Build, test, and package the desktop app:

```bash
bun dev build desktop   # compile Electron main/preload
bun run desktop:test    # desktop typecheck + unit tests
bun run desktop:pack    # local unsigned directory package
bun run desktop:dist    # local installer/package for the current platform
```

`desktop:pack` and `desktop:dist` prepare a current-platform Synergy runtime before invoking `electron-builder`. Release builds use the GitHub Actions desktop matrix to produce macOS, Windows, and Linux artifacts.

### Sandbox setup details

`bun dev prepare` compiles the sandbox helper on Linux and Windows automatically. If you need to recompile it separately:

**Linux:** `cd packages/synergy/src/sandbox/helper-linux && cargo build --release`
**Windows:** `cd packages/synergy/src/sandbox/helper && cargo build --release`

Synergy auto-discovers the locally-built binary on startup. If the hash table is empty (pre-release state), the helper is still usable with minimum plausibility checks: file size and executable permission.

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

`bun run quality:quick` is the default local PR preflight. The pre-push hook runs the fast subset: Bun version, format, lint, typecheck, and monorepo checks. CI runs the full matrix: quality, typecheck, test, package-validation, workflow-validation, secret-scan, desktop, and smoke jobs. See [docs/open-source-quality.md](docs/open-source-quality.md) for the complete model, contributor scenarios, and CI/tool responsibility table.

### Tests

Run TS tests from `packages/synergy` — the root `test` script intentionally blocks:

```bash
cd packages/synergy
bun test                                # full suite without coverage
bun run test:changed                    # tests affected by changes against origin/dev
bun run test:coverage                   # full suite with coverage, matching CI
bun run test:profile                    # write JUnit timings to coverage/test-profile-junit.xml
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
bun dev build app                              # rebuild only the web app
bun run desktop:pack                           # validate local desktop packaging
```

Regenerate the SDK after modifying server routes or route schemas.

---

## Star History

<a href="https://www.star-history.com/?repos=sii-holos%2Fsynergy&type=date&legend=top-left">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=sii-holos/synergy&type=date&theme=dark&legend=top-left" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=sii-holos/synergy&type=date&legend=top-left" />
    <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=sii-holos/synergy&type=date&legend=top-left" />
  </picture>
</a>
