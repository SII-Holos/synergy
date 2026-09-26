# Storage and Paths

Synergy keeps installation state under `<SYNERGY_HOME or OS home>/.synergy/`. `SYNERGY_HOME` selects the parent home, not the `.synergy` suffix. For example, `SYNERGY_HOME=/tmp/example` produces `/tmp/example/.synergy/`.

## Physical layout

| Path                                                      | Responsibility                                                                             |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `bin/`                                                    | Installed launchers and binaries                                                           |
| `installations/active.json`, `installations/pending.json` | Active module generation digest and recoverable promotion intent                           |
| `installations/generations/`, `installations/staging/`    | Verified module/application trees and unpublished installation stages                      |
| `installations/selection-v1.json`                         | Initial installation selection retained by the versioned bootstrap migration               |
| `installations/activated/`, `installations/sources/`      | Plugin activation receipts and immutable local package source archives                     |
| `config/`                                                 | Global domain configuration, agents, commands, skills and instructions                     |
| `data/storage/`                                           | Agent database bootstrap identity, SQLite database, migration backups and transfer records |
| `data/auth/`                                              | Provider, Holos, MCP and other account credentials                                         |
| `data/library.db`                                         | Library's independently owned SQLite knowledge database                                    |
| `data/plugin/<plugin-id>/auth.json`                       | Plugin credentials                                                                         |
| `data/plugin-install-artifacts/`                          | Private installation recovery snapshots and directory backups                              |
| `data/browser/profiles/`                                  | Persistent browser profiles and browser storage state                                      |
| `data/browser/uploads/`, `data/browser/downloads/`        | Browser file staging and downloads                                                         |
| `data/snapshot-v2/<scope>/store.git/`                     | Shared Git snapshot objects and retained references                                        |
| `data/snapshot/`                                          | Historical Git snapshot repositories until explicit migration/cleanup                      |
| `data/agent-artifacts/`                                   | Packed binary evidence; ownership and byte locators are in the Agent database              |
| `data/channel/workspaces/`                                | Channel-managed Project checkouts                                                          |
| `data/embedding/models/`                                  | Local embedding models; overridable with `embedding.local.cacheDir`                        |
| `data/tool-output/`                                       | Externalized tool output without age-based expiry                                          |
| `state/`                                                  | Process ownership, daemon and transient runtime state                                      |
| `cache/`                                                  | Rebuildable caches, including snapshot working indexes                                     |
| `log/`                                                    | Process and diagnostic logs                                                                |
| `schema/`                                                 | Installed JSON schemas                                                                     |

Library, credentials, project files, browser profiles and observability remain separate stores with their own lifecycle. Do not copy an open Library/observability SQLite file without its owning backup protocol. Cache may be cleared on upgrade and is not a backup source. Treat auth, plugin recovery snapshots, logs, signing keys and exported Home archives as private data.

## Agent database

Installation generations retain code-version floors and explicit package selections independently of Agent storage. Running processes keep their verified generation until they exit. The `installation/20260926-installation-selection-v1` migration preserves the full Web backend for a home with existing data or configuration; fresh core homes retain a minimal selection. It neither rewrites API4 grants nor installs a second Desktop shell. Bootstrap and the central migration runner share this idempotent owner.

`Storage` reads and writes logical keys inside an explicit `Storage.Handle`. Keys no longer map to `.json` files. SQLite defaults to `data/storage/agent.sqlite`; PostgreSQL uses a configured namespace. `data/storage/manifest.json` binds the backend target, database identity and local artifact identity, preventing a missing or unrelated database from being silently accepted as an empty installation.

| Logical collection                                                                                  | Owner and contents                                                                                   |
| --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `projects`                                                                                          | Scope metadata                                                                                       |
| `workspace`, `workspace_scope`, `workspace_location`                                                | Stable Workspace records and Scope/location lookup indexes                                           |
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

Eligible new manifests default to staged upgrade; `SYNERGY_STORAGE_COMPAT_DEFER=0` selects the complete startup import and `=1` explicitly selects the deferred protocol while retaining shared migration barriers. `compat_import` stores locators, counts, migration cohorts and per-owner receipts; `compat_catalog` stores immutable pending listing metadata. Frozen originals live under `data/storage/legacy/<backup-id>/sessions/`. Version 3 backup segments live under `data/storage/backups/<backup-id>/{global,sessions}/`, with the discovery inventory in `segmented.json`. Preserve the frozen tree with an incomplete backup. Format 4 additionally stores independently sealed `snapshots/` segments and protects original snapshot paths with `data/storage/snapshot-protection.json`. `compat_pending`, `compat_cleanup` and `storage_pack_pins` hold admission, retirement and package-protection state. `data/storage/compat-pause` pauses background work at resumable boundaries; explicitly requested Sessions remain available. Unresolved owners block portable transfer. See [upgrade operations](../migrations/transactional-agent-storage.md#deferred-session-import).

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

`verify` also checks every referenced binary artifact's bounds and hash. `restore-backup <backup> <destination>` verifies a sealed version 2 Home backup or a version 3/4 segmented backup and publishes a separate, new Home directory; the destination is the Home directory itself, not its parent. It rejects existing destinations and does not open the current database. An incomplete segmented backup also requires its original frozen source; restoration seals those remaining segments before publishing the restored Home. See [upgrade recovery](../migrations/transactional-agent-storage.md) for backup formats and downgrade limits.

`data pack`, `data merge` and `data move` use checksummed logical records and separately copy physical artifacts. The portable record stream is `data/agent-records.ndjson`; the target creates a new local bootstrap identity when restoring a Home archive. Target storage configuration is retained instead of importing another machine's connection settings. Conflicting Sessions are skipped as whole aggregates; source evidence and reports remain in `data/storage/transfers/`. Untrusted Home merges import Workspaces as unbound history, discard shared-write grants and local location indexes, and remap colliding identities consistently across Session selections, file history and Agenda origins. Unknown owner fields and original evidence bytes remain unchanged.

Trusted Home relocation verifies each source binding against its native directory identity and binds verified destinations to the target Home namespace. Relocated directory identities advance their binding generation; historical snapshot roots and generations remain unchanged. Destination Workspaces and grants are retained on conflicts. Scope, Session, Agenda and Channel owners relocate their known Home-local paths, while unknown fields remain untouched. Missing or replaced active directories fail the move before source removal. Source and target Homes must be disjoint, including filesystem aliases. Native directory claims exclude active Workspace users throughout copying and source removal, alongside the offline Home locks. Copied Git main and linked worktrees reconnect within the destination Home; incomplete Git relationships and unrelated destination worktrees stop the move and preserve the source.

## Credentials and independent hosts

Holos account storage at `data/auth/holos-accounts.json` is the canonical multi-account credential store. Synergy and the standalone Link host serialize updates with `data/auth/.locks/`, using the `holos-accounts:write` lock key and atomic file replacement. `api-key.json` is historical migration input, not the steady-state Holos source.

The standalone Synergy Link host owns `SYNERGY_LINK_HOME` (default `~/.synergy-link/`), including its own `state.json`, `migrations.json`, `owner.json`, control socket and logs. It is independent of Agent database ownership and must not share one host state root across live instances. See [Link operations](../operations/qizhi-synergy-link.md).

Physical private writes use flushed temporary files, atomic rename and directory sync where supported. Transient Windows sharing violations retry up to four attempts. Database durability uses the database engine's commit protocol; it is not controlled by a per-record JSON formatting or durability option.

`synergy data storage history status` reports runtime readiness, historical convergence, independent backup completeness and pause state. `history pause` and `history resume` control background work, including a running local Runtime through its control file. `history prepare <session>` and `history retry <session>` acquire exclusive maintenance ownership and wait for that owner; retry preserves quarantine and integrity evidence. Optional SQLite file rewrite requires `synergy migration run storage --maintenance` with the Runtime stopped. This command returns once the new format is usable; it does not drain free pages. `synergy data storage status` reports format and reclamation separately. Idle reclamation can be paused or resumed in Settings → Storage; `synergy data storage reclaim` explicitly drains it offline. An interrupted conversion keeps the committed data usable and resumes from durable staging unless intervening writes require that staging to be rebuilt. `synergy diagnostics --startup --output <archive>` exports bounded redacted startup logs without opening the database, including when the database cannot be read.
