# Storage and Paths

Synergy keeps installation state under `<SYNERGY_HOME or OS home>/.synergy/`. `SYNERGY_HOME` selects the parent home, not the `.synergy` suffix. For example, `SYNERGY_HOME=/tmp/example` produces `/tmp/example/.synergy/`.

## Physical layout

| Path                                               | Responsibility                                                                             |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `bin/`                                             | Installed launchers and binaries                                                           |
| `config/`                                          | Global domain configuration, agents, commands, skills and instructions                     |
| `data/storage/`                                    | Agent database bootstrap identity, SQLite database, migration backups and transfer records |
| `data/auth/`                                       | Provider, Holos, MCP and other account credentials                                         |
| `data/library.db`                                  | Library's independently owned SQLite knowledge database                                    |
| `data/plugin/<plugin-id>/auth.json`                | Plugin credentials                                                                         |
| `data/plugin-install-artifacts/`                   | Private installation recovery snapshots and directory backups                              |
| `data/browser/profiles/`                           | Persistent browser profiles and browser storage state                                      |
| `data/browser/uploads/`, `data/browser/downloads/` | Browser file staging and downloads                                                         |
| `data/snapshot-v2/<scope>/store.git/`              | Shared Git snapshot objects and retained references                                        |
| `data/snapshot/`                                   | Historical Git snapshot repositories until explicit migration/cleanup                      |
| `data/agent-artifacts/`                            | Packed binary evidence; ownership and byte locators are in the Agent database              |
| `data/channel/workspaces/`                         | Channel-managed Project checkouts                                                          |
| `data/embedding/models/`                           | Local embedding models; overridable with `embedding.local.cacheDir`                        |
| `data/tool-output/`                                | Externalized tool output without age-based expiry                                          |
| `state/`                                           | Process ownership, daemon and transient runtime state                                      |
| `cache/`                                           | Rebuildable caches, including snapshot working indexes                                     |
| `log/`                                             | Process and diagnostic logs                                                                |
| `schema/`                                          | Installed JSON schemas                                                                     |

Library, credentials, project files, browser profiles and observability remain separate stores with their own lifecycle. Do not copy an open Library/observability SQLite file without its owning backup protocol. Cache may be cleared on upgrade and is not a backup source. Treat auth, plugin recovery snapshots, logs, signing keys and exported Home archives as private data.

## Agent database

`Storage` reads and writes logical keys inside an explicit `Storage.Handle`. Keys no longer map to `.json` files. SQLite defaults to `data/storage/agent.sqlite`; PostgreSQL uses a configured namespace. `data/storage/manifest.json` binds the backend target, database identity and local artifact identity, preventing a missing or unrelated database from being silently accepted as an empty installation.

| Logical collection                                                                                  | Owner and contents                                                                                   |
| --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `projects`                                                                                          | Scope metadata                                                                                       |
| `sessions/<scope>/<session>`                                                                        | Session info, messages, parts, Inbox, Todo, DAG, history, summary and Rollout                        |
| `operations/<scope>/<operation>`                                                                    | Sessionless Rollout metadata                                                                         |
| `session_index`, `endpoint_session`, `sessions_page_index`, `session_child_index`, `session_nav_v2` | Session lookup and navigation projections                                                            |
| `session_message_order_v1`, `session_search_v1`, `session_search_dirty_v1`                          | Message ordering and rebuildable search projections                                                  |
| `permissions`, `permission-rules`                                                                   | Persistent permission state                                                                          |
| `agenda`, `blueprint_loops`, `superplan`, `lattice`, `notes`                                        | Workflow and Note domain records                                                                     |
| `channel`                                                                                           | Ownership indexes, response cards, thread bindings, provider dedup, outboxes and bounded diagnostics |
| `holos`, `synergy_link`                                                                             | Routing, contacts, mailbox and target metadata; credentials stay separate                            |
| `browser`                                                                                           | Browser Session/page metadata; profiles stay on the filesystem                                       |
| `plugin-lock`, `plugin-approvals`, `plugin-incompatible`, `registry`                                | Plugin installation, grants and registry records                                                     |
| `plugin-audit`, `plugin-runtime-state`, `plugin-install-intents`                                    | Plugin audit, health and installation recovery                                                       |
| `snapshot-v2`                                                                                       | Snapshot repository metadata, ownership and cleanup records                                          |
| `meta`                                                                                              | Versioned domain migration ledgers and recovery indexes                                              |
| `storage_recovery`, `storage_staging`, `storage_transfer`                                           | Quarantine, unpublished imports and transfer reports                                                 |

Domain extensions keep their data and migration history when unloaded. Scope/session IDs and external account IDs are record data, not an implicit filesystem authority. Read [Agent storage](../architecture/agent-storage.md) for transaction, concurrency, notification and file-commit contracts.

The opt-in `SYNERGY_STORAGE_COMPAT_DEFER=1` bootstrap boundary uses `compat_import` SQL records for Session locators, file hashes and migration staging. An already-current archived cohort can retain original files under `data/sessions/` until touch or background import. New domain migrations stage the cohort first; non-archived Sessions import before recovery. `data/storage/compat-pause` pauses the Runtime ticker. Pending or quarantined aggregates block pack, merge, move and target migration. See [deferred import operations](../migrations/transactional-agent-storage.md#deferred-session-import).

## Configuration and commands

Global `config/synergy.d/130-storage.jsonc` selects storage. Omission selects SQLite. PostgreSQL configuration uses an environment-variable name rather than an inline password:

```json
{
  "storage": {
    "backend": "postgres",
    "namespace": "my-agent-data",
    "connectionEnv": "SYNERGY_DATABASE_URL",
    "maxConnections": 8
  }
}
```

Use `synergy data storage status` to inspect the active dataset, `verify` to check integrity and relationships, `resume` to finish interrupted upgrades or switches, and `migrate --target <config-file>` to change backend, namespace or SQLite location. These commands acquire the appropriate read-only or exclusive maintenance Handle. They do not stop the running Runtime.

`verify` also checks every referenced binary artifact's bounds and hash. `restore-backup <backup> <destination>` verifies a sealed version 2 legacy backup and publishes a separate, new Home directory; the destination is the Home directory itself, not its parent. It rejects existing destinations and does not open the current database. See [upgrade recovery](../migrations/transactional-agent-storage.md) for backup formats and downgrade limits.

`data pack`, `data merge` and `data move` use checksummed logical records and separately copy physical artifacts. The portable record stream is `data/agent-records.ndjson`; the target creates a new local bootstrap identity when restoring a Home archive. Target storage configuration is retained instead of importing another machine's connection settings. Conflicting Sessions are skipped as whole aggregates; source evidence and reports remain in `data/storage/transfers/`.

## Credentials and independent hosts

Holos account storage at `data/auth/holos-accounts.json` is the canonical multi-account credential store. Synergy and the standalone Link host serialize updates with `data/auth/.locks/`, using the `holos-accounts:write` lock key and atomic file replacement. `api-key.json` is historical migration input, not the steady-state Holos source.

The standalone Synergy Link host owns `SYNERGY_LINK_HOME` (default `~/.synergy-link/`), including its own `state.json`, `migrations.json`, `owner.json`, control socket and logs. It is independent of Agent database ownership and must not share one host state root across live instances. See [Link operations](../operations/qizhi-synergy-link.md).

Physical private writes use flushed temporary files, atomic rename and directory sync where supported. Transient Windows sharing violations retry up to four attempts. Database durability uses the database engine's commit protocol; it is not controlled by a per-record JSON formatting or durability option.
