# CLI Reference

The installed `synergy` CLI manages the product runtime and submits work to it. Source development uses the separate root `bun dev` orchestrator described in [Development](development.md).

Run `synergy --help` or `synergy <command> --help` for the exact options supported by the installed version.

## Global Options

| Option                                 | Meaning                                            |
| -------------------------------------- | -------------------------------------------------- |
| `-h`, `--help`                         | Show command help                                  |
| `-v`, `--version`                      | Show the installed version                         |
| `--print-logs`                         | Mirror runtime logs to stderr                      |
| `--log-level DEBUG\|INFO\|WARN\|ERROR` | Override the configured log level for this process |
| `completion`                           | Generate a shell completion script                 |

## Runtime Modes

| Command            | Ownership and lifetime                                                                                            |
| ------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `synergy start`    | Install/start a managed background service through launchd, systemd user services, or Windows Task Scheduler      |
| `synergy server`   | Run the server in the current foreground terminal; bare `synergy` is an alias for this command                    |
| `synergy web`      | Open the Web UI served by an already running runtime                                                              |
| `synergy send ...` | Attach to a runtime when `--attach` is supplied; otherwise start a private ephemeral local server for the command |

These modes share data and configuration when they use the same `SYNERGY_HOME`, but only one persistent server process may own that home at a time. A private `send` server stops when its task reaches idle.

### Background service

```bash
synergy start
synergy status
synergy status --verbose
synergy logs --follow
synergy stop
```

`start` runs the first-time configuration wizard in an interactive terminal when no config exists. `--non-interactive` skips first-run and Holos prompts. Existing services report config drift; stop and start again to install changed network settings into the service definition.

The managed service defaults to `127.0.0.1:4096`. `--hostname`, `--port`, `--mdns`, and repeatable `--cors` override the corresponding `server` config for the installed service invocation.
Each explicit `--cors` value authorizes both cross-origin HTTP requests and Browser viewer WebSocket handshakes from that exact HTTP(S) origin. Automatically detected LAN CORS origins and reverse-proxy forwarding headers do not authorize Browser viewer sockets, so pass the public Browser viewer Origin explicitly.

`status --verbose` adds runtime-lock, health, process, listening-port, trace, and local process-registry information. `stop` manages only the installed background service; do not use it as a generic process killer for an unrelated foreground server.

### Foreground server

```bash
synergy server
synergy server --hostname 127.0.0.1 --port 4097
```

The foreground command defaults its CLI hostname to `0.0.0.0`. Port `0` asks the server to prefer 4096 and fall back to an available ephemeral port. Global `server` configuration applies unless a network option is explicit. Use an explicit loopback hostname when the runtime should not accept LAN connections.

The server lock reports the existing PID, mode, working directory, command, health, and listening ports when another server already owns the same Synergy home.

### Web

```bash
synergy web
synergy web --attach http://localhost:4097
```

`web` does not start a server. It verifies `/global/health`, verifies that the target serves the Web application, and opens the authenticated attach URL. The default target is `http://localhost:4096`.

## One-off Work with `send`

```bash
synergy send "Summarize this project"
synergy send --scope home "Summarize recent work"
synergy send --scope <scope-id> "Continue work in that project"
synergy send --attach http://localhost:4096 "Continue the work"
synergy send --agent synergy-max --model provider/model "Fix the failing test"
synergy send --file report.pdf --file src "Review these inputs"
printf 'extra context' | synergy send "Use stdin too"
```

Important options:

| Option                           | Meaning                                                                                    |
| -------------------------------- | ------------------------------------------------------------------------------------------ |
| `--attach <url>`                 | Use a running server instead of a private ephemeral server                                 |
| `--scope <id>`                   | Use the registered home or project Scope ID; unknown or archived IDs fail without creation |
| `-c`, `--continue`               | Continue the latest top-level session in the selected Scope                                |
| `-s`, `--session <id>`           | Continue a specific session                                                                |
| `--agent <name>`                 | Select a primary agent; subagent names are rejected as primary choices                     |
| `-m`, `--model <provider/model>` | Override the model                                                                         |
| `--variant <name>`               | Select provider-specific reasoning/model variant                                           |
| `-f`, `--file <path>`            | Attach a file or directory; repeatable                                                     |
| `--command <name>`               | Run a configured Synergy command, using the message as arguments                           |
| `--title [text]`                 | Set the new-session title; an empty value derives it from the prompt                       |
| `--format default\|json`         | Render progress for humans or emit newline-delimited event JSON                            |
| `--port <number>`                | Port for the private local server; omitted means an available port                         |

When `--scope` is omitted, `send` uses the launch directory (or `SYNERGY_CWD`). An existing directory is resolved and registered as a project Scope when needed, even if Synergy has not opened it before; a missing directory resolves to the home Scope. Pass `--scope` to select an already registered Scope without registering the launch directory. With `--attach`, the target runtime owns and validates the Scope ID.

Piped stdin is appended to the prompt. The command subscribes to session events before prompting, renders completed tools and terminal text, and handles interactive `guarded` permission requests with allow-once or reject choices.

## Configuration, Providers, and Models

| Command family                               | Purpose                                                         |
| -------------------------------------------- | --------------------------------------------------------------- |
| `synergy config path`                        | Print config, data, and cache roots                             |
| `synergy config wizard`                      | Detect providers and write core model configuration             |
| `synergy config import <file-or-url>`        | Preview or apply domain-aware config import                     |
| `synergy config embedding`                   | Configure an embedding provider                                 |
| `synergy config rerank`                      | Configure a rerank provider                                     |
| `synergy auth login\|logout\|list\|usage`    | Manage provider credentials and inspect supported usage windows |
| `synergy models [provider]`                  | List available configured models                                |
| `synergy agent create\|list`                 | Create or inspect agent definitions                             |
| `synergy mcp add\|list\|auth\|logout\|debug` | Configure, authenticate, and inspect MCP servers                |
| `synergy embed download`                     | Download the local embedding model assets                       |

### config import

`synergy config import <source>` imports JSON or JSONC configuration from a local file path or an HTTP(S) URL. Sources are limited to 1 MiB; URL fetches time out after 15 seconds and reject redirects. The command produces a domain-aware plan, shows value-level changes, and asks for confirmation before applying.

```bash
synergy config import ./settings.jsonc
synergy config import https://example.com/config.json --dry-run
synergy config import ./config.jsonc --scope project --only models --only providers
synergy config import ./config.jsonc --mode replace-domain --yes
```

| Option                                 | Meaning                                                                      |
| -------------------------------------- | ---------------------------------------------------------------------------- |
| `--scope global\|project`              | Target scope; defaults to `global`; project scope requires an active project |
| `--only <domain>`                      | Import only the named domain; repeatable for multiple domains                |
| `--mode merge\|replace-domain\|append` | Override the per-domain default merge policy                                 |
| `--dry-run`                            | Show the plan without writing files                                          |
| `--force`                              | Apply even when config changed after planning (stale revision)               |
| `--yes`, `-y`                          | Skip the confirmation prompt                                                 |

All domains are importable and default to `merge` mode. `append` recursively merges objects and appends arrays in source order; imported scalar values override existing values. Conflicts and hardcoded secrets are flagged as warnings without blocking. A stale plan (config changed between plan and apply) is rejected unless `--force` is supplied.

JSONC comments in existing domain files are preserved. Committed files trigger a runtime config reload; reload failure does not roll back the committed changes.

The `openai-codex` provider uses ChatGPT/Codex OAuth credentials and the Codex backend. The `openai` provider uses OpenAI Platform API-key credentials. Their login, storage, usage, and billing semantics are intentionally separate.

See [Configuration](configuration.md) for files, precedence, domains, and instruction discovery.

### embed download

`synergy embed download` fetches the bundled local embedding model (`Xenova/all-MiniLM-L6-v2`, ~80 MB) so that embedding calls start instantly. The command is for local mode; when a remote embedding API key is configured it exits immediately with "No download needed."

```bash
synergy embed download
```

The command displays:

- the model name, size, and purpose
- the configured download source (Hugging Face Hub, HF Mirror, or custom)
- live byte and percentage progress, updated roughly every 250 ms
- success confirmation with the final "ready" message

On failure, the command prints the error and suggests troubleshooting steps: check the network connection, verify the configured download source in `embedding.local.source`, or configure a remote embedding API with `synergy config embedding`.

The download source is set in `00-general.jsonc` under `embedding.local.source` (`"huggingface"`, `"hf-mirror"`, or `"custom"`). The `custom` source requires `embedding.local.remoteHost` to be a public HTTPS origin.

See [Knowledge: Embedding Model](../product/knowledge.md#embedding-model) for the embedding lifecycle and [Configuration: Embedding](configuration.md#embedding) for the full config schema.

## Sessions, Library, and Data

| Command family                                      | Purpose                                                                                                            |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `synergy session list`                              | List sessions for a Scope                                                                                          |
| `synergy session inspect <id>`                      | Inspect one session                                                                                                |
| `synergy session delete <id>`                       | Delete one session                                                                                                 |
| `synergy session repair`                            | Run session integrity/recovery repair                                                                              |
| `synergy export [sessionID]`                        | Export session data                                                                                                |
| `synergy import <file>`                             | Import an exported session                                                                                         |
| `synergy import-claude [file]`                      | Import a Claude Code transcript as a Synergy session                                                               |
| `synergy import-codex [file]`                       | Import a Codex CLI transcript as a Synergy session                                                                 |
| `synergy library show\|learning\|memory\|reencode`  | Inspect and maintain Library learning state                                                                        |
| `synergy stats`                                     | Read or recompute installation-wide session, model, agent, tool, token, cost, code-change, and activity statistics |
| `synergy data path`                                 | Show the current Synergy home/data location                                                                        |
| `synergy data pack [output]`                        | Pack selected data categories                                                                                      |
| `synergy data merge <source>`                       | Merge a data bundle into the current home                                                                          |
| `synergy data move <target>`                        | Move managed Synergy data                                                                                          |
| `synergy data set-home <path>`                      | Set the configured data home                                                                                       |
| `synergy migrate [--target <path>]`                 | Backward-compatible alias for the interactive data-move workflow                                                   |
| `synergy migration status\|run\|rollback\|generate` | Inspect and manage versioned schema/data migrations                                                                |

### import-claude and import-codex

`synergy import-claude [file]` imports a Claude Code transcript (jsonl under `~/.claude/projects`) as a Synergy session; `synergy import-codex [file]` imports a Codex CLI transcript (jsonl under `~/.codex/sessions`) as a Synergy session. Both commands share the same options. The default scan roots honor `$CLAUDE_CONFIG_DIR` and `$CODEX_HOME`; scanning the Codex default location also includes the sibling `archived_sessions` directory.

With a `file` argument, the command imports that single transcript and prints the resulting root session ID with session and message counts. Malformed lines and unknown line types are skipped and counted instead of failing the import. If the write fails, every session created by the attempt is rolled back, so an import never leaves partial data.

Without a `file` argument, the command scans for candidate transcripts and imports them newest first:

```bash
synergy import-claude                    # scan ~/.claude/projects and import all transcripts
synergy import-claude --dry-run          # list matching transcripts without importing
synergy import-claude --dir ./transcripts
synergy import-claude --limit 10         # import at most 10 sessions, newest first
synergy import-claude --include-sidechains
synergy import-codex --include-thinking  # keep reasoning blocks as reasoning parts
```

| Option                 | Meaning                                                           |
| ---------------------- | ----------------------------------------------------------------- |
| `file`                 | Path to one transcript jsonl; omit to scan and batch import       |
| `--dir <path>`         | Scan a custom directory instead of the source's default root      |
| `--dry-run`            | List matching transcript files without importing                  |
| `--limit <n>`          | Import at most `n` sessions, newest first                         |
| `--include-sidechains` | Also import subagent (sidechain) transcripts; excluded by default |
| `--include-thinking`   | Include thinking/reasoning blocks as reasoning parts              |

A batch import runs as a server-owned job with progress; the CLI waits for completion and prints a per-file failure summary. The same workflow is available in the Web settings under **Session Import**.

Use the data commands for supported relocation and merge workflows. Copying individual JSON files while the server is running can violate indexes and atomic update assumptions.

`synergy stats --json` emits the complete snapshot; `--recompute` rebuilds its derived digests and buckets, while `--days`, `--tools`, and `--models` change the displayed view. The accepted `--project` option currently recomputes but does not filter the installation-wide result. See [Activity and Statistics](../product/activity-and-statistics.md).

## Connections

| Command family                                                        | Purpose                                        |
| --------------------------------------------------------------------- | ---------------------------------------------- |
| `synergy channel add\|list\|start\|stop\|status`                      | Configure and control Channel accounts         |
| `synergy holos login\|logout\|status\|verify\|reconnect\|credentials` | Manage Holos identity and connection readiness |
| `synergy acp`                                                         | Run the Agent Client Protocol integration      |

Channel and Holos connection models are described in [Connections](../product/connections.md).

## Browser Installation and Diagnostics

```bash
synergy browser doctor
synergy browser doctor --json
synergy browser install
synergy browser install --force --json
synergy browser install --no-deps
synergy browser install-deps
```

`browser doctor` checks Chromium discovery, executable version, and an actual headless launch using the same arguments as Browser tools. On Linux it also reports dynamic-loader diagnostics. The command exits with status 1 when Browser is not ready; `--json` emits the complete structured report.

`browser install` downloads Chromium into Synergy-managed data without replacing system browsers. It accepts only a release manifest signed by Synergy, verifies the target, archive size, and SHA-256 digest, and installs atomically. Repeated installs reuse the current managed version; `--force` reinstalls it.

On Linux, `browser install` also installs the distribution packages required by the release's pinned Playwright version. This system-package step can invoke `sudo` or `su`; run it from an account authorized to install packages. Use `--no-deps` when those packages are managed separately, or run `browser install-deps` to repair only the system dependencies. JSON install reports include `systemDependencies` with `installed`, `not-required`, or `skipped`.

Local source builds do not have signed release manifests; use an installed release or set `CHROMIUM_PATH`. Unsupported platforms can also install Chrome or Chromium separately and set `CHROMIUM_PATH`.

## Diagnostics and Maintenance

| Command                    | Purpose                                                                                    |
| -------------------------- | ------------------------------------------------------------------------------------------ |
| `synergy doctor`           | Run installation and runtime health checks                                                 |
| `synergy diagnostics`      | Collect a redacted diagnostics bundle                                                      |
| `synergy logs [--follow]`  | Read the current log stream                                                                |
| `synergy debug ...`        | Developer inspection for config, agents, files, LSP, ripgrep, skills, snapshots, and paths |
| `synergy upgrade [target]` | Upgrade the installed release                                                              |
| `synergy uninstall`        | Remove the installed product after confirmation/options                                    |
| `synergy generate`         | Generate supported artifacts used by development/release workflows                         |

`synergy upgrade` preserves the detected installation channel. Package-manager installations use their owning manager, Desktop installations defer to the Desktop updater, and standalone CLI installations with the binary at `~/.synergy/bin/synergy` rerun the official installer pinned to the requested release's `vX.Y.Z` GitHub tag. Standalone upgrades therefore require a published GitHub release tag and do not use an npm-only dev or preview version's installer. Override detection with `--method <npm|yarn|pnpm|bun|brew|desktop|standalone>`. If the installation method cannot be determined, the command stops with recovery guidance instead of attempting an unknown upgrade path.

`debug` and migration commands are maintainer-oriented. Prefer stable product commands and APIs for application integrations.

## Plugins

`synergy plugin` includes create, add, remove, update, build, sign, pack, list, search, doctor, validate, dev, runtime, test, publish-market, entry, info, permissions, and approval commands. `synergy plugin approve <id>` fetches the server approval review for a configured plugin and submits the opaque `reviewToken` through `POST /api/plugins/approve`; it does not send manifest, capability, source, or path data. `list` and `info` show approval-disabled plugins with their canonical identity and `Needs approval` state. Installed plugins can also contribute their own top-level CLI commands.

The canonical authoring and command reference is [Plugin documentation](../plugins/README.md).
