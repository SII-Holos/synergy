---
name: inspect-sessions
description: "Guide for reading raw Synergy session data from the filesystem storage. Use when investigating session state, reading message JSON directly, understanding the storage layout, or debugging persistence issues. Triggers: 'session data', 'storage', 'session json', 'raw session', 'where are sessions', 'persistence', 'inspect session', 'migration'."
---

# Inspecting Session Data and Storage

## Storage Overview

Synergy uses **file-based JSON storage** for all persistent data. Everything — sessions, messages, permissions, agenda items, notes — lives as JSON files under `~/.synergy/data/`. SQLite is only used for the embeddings library (`library.db`).

All paths resolve relative to `Global.Path.data` = `~/.synergy/data/`.

## Directory Structure

```
~/.synergy/data/
├── sessions/{scopeID}/{sessionID}/
│   ├── info.json              # Session metadata (title, model, time, parentID)
│   ├── summary.json           # Session summary text
│   ├── dag.json               # DAG task graph state
│   ├── todo.json              # To-do list state
│   ├── inbox/{itemID}.json    # Inbox items
│   └── messages/{messageID}/
│       ├── info.json          # Message metadata (role, timestamps, parentID)
│       ├── parts/{partID}.json    # Individual message parts (text/tool-call/tool-result/attachment)
│       └── history/{historyID}.json  # Undo/rewind history records
├── session_index/{sessionID}.json    # Global sessionID → scopeID lookup
├── session_nav_v2/{scopeID}.json     # Session navigation index
├── session_child_index/{scopeID}/{parentID}.json  # Parent → child relationships
├── session_page_index/{scopeID}.json  # Session page index
├── notes/{scopeID}/{noteID}.json
├── permissions/{scopeID}.json         # Permission overrides per scope
├── permission-rules.json              # Global permission rules
├── agenda/items/{scopeID}/{itemID}.json
├── agenda/runs/{scopeID}/{itemID}/{runID}.json
├── meta/version.json                  # Storage schema version
├── meta/migration/log-{domain}.json   # Migration tracking per domain
├── auth/                              # API keys, provider OAuth, MCP credentials
├── shares/{shareID}.json
├── holos/contacts/{id}.json
├── holos/mailbox/{inbox|outbox}/{contactId}/{msgId}.json
└── stats/                             # Usage statistics
```

## How to Find a Session

### From the filesystem

```bash
# Find your scope ID (SHA of project path)
# Look in session_index for recent sessions
ls -lt ~/.synergy/data/sessions/

# All sessions in a scope
ls ~/.synergy/data/sessions/{scopeID}/

# Global lookup: sessionID → scopeID
cat ~/.synergy/data/session_index/{sessionID}.json | jq .

# Read session metadata
cat ~/.synergy/data/sessions/{scopeID}/{sessionID}/info.json | jq .

# Message count
ls ~/.synergy/data/sessions/{scopeID}/{sessionID}/messages/ | wc -l

# A message's parts
ls ~/.synergy/data/sessions/{scopeID}/{sessionID}/messages/{messageID}/parts/

# Read a part (tool call, tool result, or text)
cat ~/.synergy/data/sessions/{scopeID}/{sessionID}/messages/{messageID}/parts/{partID}.json | jq .
```

### From code

```ts
import { Storage } from "@/storage/storage"
import { StoragePath } from "@/storage/path"

// Read session metadata
const info = await Storage.read(StoragePath.sessionInfo(scopeID, sessionID))

// Scan all messages in a session
const messages = await Storage.scan(StoragePath.messages(scopeID, sessionID))

// List all sessions in a scope
const entries = await Storage.list(StoragePath.sessions(scopeID))

// Read a single message
const msg = await Storage.read(StoragePath.messageInfo(scopeID, sessionID, messageID))

// Read a message part
const part = await Storage.read(StoragePath.part(scopeID, sessionID, messageID, partID))
```

## Storage Write Properties

- **Atomic writes**: Writes go to a temp file (`.tmp-{pid}-{timestamp}-{random}.json`), then `rename()` — no partial writes.
- **Compact JSON**: Message and part writes use `{ compact: true }` (no pretty-print) for performance on the hot path.
- **Pretty JSON**: Session metadata, config, and other writes use indented JSON for readability.
- **Concurrent reads**: `Storage.readMany()` uses parallel reads (concurrency 32).

## Key Code Files

| File                                      | Purpose                                                                 |
| ----------------------------------------- | ----------------------------------------------------------------------- |
| `packages/synergy/src/storage/storage.ts` | `Storage.read()`, `write()`, `update()`, `scan()`, `list()`, `remove()` |
| `packages/synergy/src/storage/path.ts`    | `StoragePath` namespace — all canonical key builders                    |
| `packages/synergy/src/global/index.ts`    | `Global.Path` — root path resolution, env vars, cache version           |

## Migration System

Migrations run on server startup via `migration/index.ts`. They upgrade persisted data between versions.

### Domains (10 active)

`session`, `scope`, `config`, `library`, `agenda`, `note`, `blueprint_loop`, `holos`, `browser`

### Tracking

Completed migrations are recorded in `meta/migration/log-{domain}.json`:

```bash
cat ~/.synergy/data/meta/migration/log-session.json | jq .
```

### Migration Interface

```ts
interface Migration {
  id: string // e.g. "20260701-session-workflow-fields"
  description: string
  up(progress): Promise<void>
  down?(progress): Promise<void> // Optional rollback
  dependsOn?: string[] // DAG ordering
  version?: string // Semver for ordering
}
```

### Adding a New Migration

1. Add the migration object to the domain's migration file (e.g., `src/session/migration.ts`)
2. Register it: `MigrationRegistry.register("session", [...existing, newMigration])`
3. The runner handles ordering (topological by `dependsOn` > semver by `version` > lexical by `id`)
4. Rollback supported via `rollbackMigrations(domain, targetId)` — runs `down()` in reverse

## Quick Reference: Path Resolution

In code, all paths go through `Global.Path` (`src/global/index.ts`):

```ts
Global.Path.data // ~/.synergy/data/
Global.Path.log // ~/.synergy/log/
Global.Path.state // ~/.synergy/state/
Global.Path.config // ~/.synergy/config/
Global.Path.cache // ~/.synergy/cache/
Global.Path.auth // ~/.synergy/data/auth/
```

Override with `SYNERGY_HOME` env var:

```bash
SYNERGY_HOME=/custom/path bun dev server
# → /custom/path/.synergy/data/...
```
