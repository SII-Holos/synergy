# Storage and Paths

Synergy keeps installation state under one root:

```text
<SYNERGY_HOME or OS home>/.synergy/
```

`SYNERGY_HOME` changes the parent home, not the `.synergy` suffix. For example, `SYNERGY_HOME=/tmp/example` produces `/tmp/example/.synergy/`.

## Top-Level Layout

| Path      | Responsibility                                                         |
| --------- | ---------------------------------------------------------------------- |
| `bin/`    | installed launchers and binaries                                       |
| `config/` | global domain config, global agents/commands/skills, instruction files |
| `data/`   | durable product data and auth stores                                   |
| `log/`    | normal process logs                                                    |
| `state/`  | daemon, runtime, trace, and process state                              |
| `cache/`  | disposable model/provider/marketplace and derived caches               |
| `schema/` | installed JSON schemas                                                 |

Cache version changes can clear `cache/` on startup. Treat cache as reproducible, not as a backup source.

## JSON Storage

Most durable product objects use file-based JSON storage rooted at `data/`. A logical storage key maps to nested directories plus a `.json` suffix. Writes take per-file locks and use a temporary file followed by atomic rename. Streaming message/part writes can use compact JSON; lower-frequency records remain indented.

Major collections include:

```text
data/projects/
data/session_index/
data/sessions_page_index/
data/session_child_index/
data/session_nav_v2/
data/sessions/<scope>/<session>/
data/endpoint_session/
data/permissions/
data/permission-rules.json
data/notes/<scope>/
data/agenda/items/<scope>/
data/agenda/runs/<scope>/<item>/
data/blueprint_loops/<scope>/
data/superplan/runs/<scope>/
data/superplan/events/<scope>/<run>/
data/lattice/runs/<scope>/
data/lattice/events/<scope>/
data/holos/contacts/
data/holos/mailbox/
data/stats/
```

Inside a session, `info.json`, `summary.json`, `todo.json`, `dag.json`, `inbox/`, `messages/`, and `history/` are separate records. Message info and each part are independently addressable, which supports streaming writes and narrow reads.

The session index, paged-session index, child-session index, and navigation index are derived but operationally important. Do not hand-move one session directory without its Scope/session indexes; use export/import, data, migration, or repair workflows.

## Library Database

Library uses:

```text
data/library.db
```

It is a Bun SQLite database with WAL behavior and optional `sqlite-vec` tables for Memory and Experience embeddings. It is installation-global while records retain Scope/session metadata. SQLite sidecar files can exist while the server is active; copy the database only through a consistent backup workflow.

## Credentials

Credential files live under `data/auth/`, including:

- `api-key.json` and `provider-auth.json`
- `holos-accounts.json`
- `mcp.json`
- integration-specific auth stores

Holos account storage is permissioned to the local user. Treat the entire auth directory as sensitive. Diagnostics and SmartAllow use redaction/metadata paths rather than exposing raw secrets.

Plugin-scoped credentials live separately at `data/plugin/<plugin-id>/auth.json`. Plugin approvals, audit history, runtime health, and the local registry use `data/plugin-approvals.json`, `data/plugin-audit.json`, `data/plugin-runtime-state.json`, and `data/registry/plugins.json`; `plugin.lock` at the installation root binds installed specs to resolved artifacts and integrity. Treat plugin auth and signing material under `keys/` as sensitive even when the plugin itself is trusted.

## Browser, Worktrees, and Artifacts

| Path                      | Content                                                    |
| ------------------------- | ---------------------------------------------------------- |
| `data/browser/sessions/`  | canonical Browser session/page metadata                    |
| `data/browser/profiles/`  | persistent browser profiles and storage state              |
| `data/browser/uploads/`   | owner-scoped upload staging                                |
| `data/browser/downloads/` | browser downloads grouped by Scope                         |
| `data/browser/chromium/`  | managed Chromium assets                                    |
| `data/worktree/`          | Synergy-managed worktree metadata/resources                |
| `data/snapshot/`          | file snapshots used by history/file restoration            |
| `data/tool-output/`       | large tool outputs externalized from message records       |
| `data/assets/`            | product/plugin assets                                      |
| `data/media/`             | generated or captured media, including Browser screenshots |

Archiving or deleting a session disposes its live Browser runtime, but persisted Browser state follows its own lifecycle and migration rules.

## Daemon and Observability State

Managed service state is under:

```text
state/daemon/manifest.json
state/daemon/runtime-lock.json
state/daemon/logs/server.log
```

The lock records PID, server/daemon mode, command, and working directory. A stale or conflicting lock is inspected rather than blindly overwritten.

Platform service definitions live in platform-owned locations:

- macOS: `~/Library/LaunchAgents/dev.synergy.server.plist`
- Linux: `~/.config/systemd/user/synergy.service`
- Windows: Task Scheduler plus launch scripts in `state/daemon/`

Structured observability traces live under `state/observability/traces/`. Performance and diagnostics state may add adjacent state/data records. `synergy status --verbose`, `synergy logs`, and `synergy diagnostics` are the supported inspection entry points.

Plugin installation stages artifacts and holds its transaction lock under `state/plugin-install/`. Cached plugin packages, extracted archives, marketplace records, models, provider catalogs, and downloaded runtime dependencies live under `cache/`; they may be recreated and must not be treated as approval or credential records. LSP process bookkeeping is kept in `state/lsp-pids.json`.

## Project-Local `.synergy`

A repository's `.synergy/` is project configuration and extension source, not the installation data root:

```text
<project>/.synergy/synergy.d/
<project>/.synergy/agent/
<project>/.synergy/command/
<project>/.synergy/skill/
```

Project worktrees may also be managed beneath a project-local Synergy area. Permission policy treats the active worktree as the write/execute boundary and the original checkout as readable but protected from autonomous modification.

## Relocation and Backup

Stop the server before raw filesystem backup or relocation. For supported selective movement, use `synergy data pack`, `merge`, `move`, and `set-home`. Use session export/import for portable session artifacts.

Never include `data/auth/` in a public diagnostics bundle, issue attachment, or repository commit.
