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
| `synergy tui`      | Open the terminal UI attached to an already running runtime                                                       |
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

### Terminal UI

```bash
synergy tui
synergy tui --directory ./my-project
synergy tui --scope <scope-id> --session <session-id>
synergy tui --attach http://localhost:4097 --theme dark
```

`tui` is an interactive client and does not start a server. It requires terminal stdin and stdout, connects to `http://localhost:4096` by default, and uses the current directory to resolve the active Scope unless `--scope` is supplied. `--directory` and `--scope` are mutually exclusive. `--session` opens a specific session initially, and `--theme system|light|dark` selects terminal colors; `system` uses the terminal-reported background when available.

The client renders a responsive session list, streamed Markdown and reasoning, tool activity and diffs, active Todo/DAG summaries, runtime commands, permissions, and questions. It subscribes before bootstrap, replays sequenced gaps after reconnect, and performs a full Scope resync when the runtime epoch or replay journal requires it.

| Key                 | Action                                                                                |
| ------------------- | ------------------------------------------------------------------------------------- |
| `Enter`             | Send the composer text or execute a leading `/command`                                |
| `Shift+Enter`       | Insert a newline                                                                      |
| `Up` / `Down`       | Navigate input history at the first/last composer line                                |
| `Tab` / `Shift+Tab` | Move between composer and sessions; compact terminals open the session picker         |
| `Ctrl+K`            | Open the runtime command palette and insert a selected command for review             |
| `Ctrl+N`            | Create and select a new session                                                       |
| `Ctrl+P`            | Pin or unpin the active session                                                       |
| `Ctrl+C`            | Abort active work when the session is busy; otherwise quit and restore terminal state |
| `Escape`            | Dismiss a modal, or move focus out of the composer                                    |

The footer presents context-sensitive hints rather than every binding at once. Wide idle sessions show create, pin, command, and focus actions; compact terminals prioritize the session picker, and busy sessions prioritize abort. Modal overlays replace the normal hints with navigation controls. The connection indicator uses `●` for live, `○` for offline, and `◐` for transitional states. The bindings above do not change when a hint is hidden.

Permission modals expose allow-once, allow-for-session, persistent allow, and reject decisions supported by the runtime. Question modals support single and multiple selection. All runtime and model strings are sanitized before terminal rendering.

## One-off Work with `send`

```bash
synergy send "Summarize this project"
synergy send --attach http://localhost:4096 "Continue the work"
synergy send --agent synergy-max --model provider/model "Fix the failing test"
synergy send --file report.pdf --file src "Review these inputs"
printf 'extra context' | synergy send "Use stdin too"
```

Important options:

| Option                           | Meaning                                                                |
| -------------------------------- | ---------------------------------------------------------------------- |
| `--attach <url>`                 | Use a running server instead of a private ephemeral server             |
| `-c`, `--continue`               | Continue the latest top-level session in the current Scope             |
| `-s`, `--session <id>`           | Continue a specific session                                            |
| `--agent <name>`                 | Select a primary agent; subagent names are rejected as primary choices |
| `-m`, `--model <provider/model>` | Override the model                                                     |
| `--variant <name>`               | Select provider-specific reasoning/model variant                       |
| `-f`, `--file <path>`            | Attach a file or directory; repeatable                                 |
| `--command <name>`               | Run a configured Synergy command, using the message as arguments       |
| `--title [text]`                 | Set the new-session title; an empty value derives it from the prompt   |
| `--format default\|json`         | Render progress for humans or emit newline-delimited event JSON        |
| `--port <number>`                | Port for the private local server; omitted means an available port     |

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
| `synergy library show\|learning\|memory\|reencode`  | Inspect and maintain Library learning state                                                                        |
| `synergy stats`                                     | Read or recompute installation-wide session, model, agent, tool, token, cost, code-change, and activity statistics |
| `synergy data path`                                 | Show the current Synergy home/data location                                                                        |
| `synergy data pack [output]`                        | Pack selected data categories                                                                                      |
| `synergy data merge <source>`                       | Merge a data bundle into the current home                                                                          |
| `synergy data move <target>`                        | Move managed Synergy data                                                                                          |
| `synergy data set-home <path>`                      | Set the configured data home                                                                                       |
| `synergy migrate [--target <path>]`                 | Backward-compatible alias for the interactive data-move workflow                                                   |
| `synergy migration status\|run\|rollback\|generate` | Inspect and manage versioned schema/data migrations                                                                |

Use the data commands for supported relocation and merge workflows. Copying individual JSON files while the server is running can violate indexes and atomic update assumptions.

`synergy stats --json` emits the complete snapshot; `--recompute` rebuilds its derived digests and buckets, while `--days`, `--tools`, and `--models` change the displayed view. The accepted `--project` option currently recomputes but does not filter the installation-wide result. See [Activity and Statistics](../product/activity-and-statistics.md).

## Connections

| Command family                                                        | Purpose                                        |
| --------------------------------------------------------------------- | ---------------------------------------------- |
| `synergy channel add\|list\|start\|stop\|status`                      | Configure and control Channel accounts         |
| `synergy holos login\|logout\|status\|verify\|reconnect\|credentials` | Manage Holos identity and connection readiness |
| `synergy acp`                                                         | Run the Agent Client Protocol integration      |

Channel and Holos connection models are described in [Connections](../product/connections.md).

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

`debug` and migration commands are maintainer-oriented. Prefer stable product commands and APIs for application integrations.

## Plugins

`synergy plugin` includes create, add, remove, update, build, sign, pack, list, search, doctor, validate, dev, runtime, test, publish-market, entry, info, permissions, and approval commands. `synergy plugin approve <id>` fetches the server approval review for a configured plugin and submits the opaque `reviewToken` through `POST /api/plugins/approve`; it does not send manifest, capability, source, or path data. `list` and `info` show approval-disabled plugins with their canonical identity and `Needs approval` state. Installed plugins can also contribute their own top-level CLI commands.

The canonical authoring and command reference is [Plugin documentation](../plugins/README.md).
