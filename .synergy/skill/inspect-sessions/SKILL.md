---
name: inspect-sessions
description: Inspect Synergy session metadata, health, messages, parts, inbox, indexes, lineage, and migration state without unsafe hydration or filesystem mutation. Use for corrupt or missing sessions, stuck pending replies, raw session JSON, Scope lookup, recovery, storage debugging, and session persistence investigations.
---

# Inspect Session State

## Start with Recovery-safe Commands

Preserve the target `SYNERGY_HOME` and working directory so Scope resolution matches the session.

```bash
synergy session list --format json --max-count 20
synergy session list --with-health --format json
synergy session inspect <session-id> --json
```

`session inspect` reads health metadata without hydrating the message history. Supply `--scope <scope-id>` only when the global session index is missing.

For index problems, preview repairs before any mutation:

```bash
synergy session repair --dry-run --json
```

Run `--apply` or `session delete --yes` only when the user explicitly requests the state change and the inspection proves it is appropriate.

## Inspect Raw Storage Read-only

Read [Storage and paths](../../../docs/reference/storage-and-paths.md) and [Sessions and messages](../../../docs/architecture/session-and-messages.md) before interpreting records.

Resolve the root as `<SYNERGY_HOME or OS home>/.synergy/data/`. Use the session index to find the owning Scope, then inspect:

```text
session_index/<session-id>.json
sessions/<scope-id>/<session-id>/info.json
sessions/<scope-id>/<session-id>/messages/<message-id>/info.json
sessions/<scope-id>/<session-id>/messages/<message-id>/parts/<part-id>.json
```

Use `jq`, `rg`, `find`, and `ls` only for read-only inspection. Derive exact paths from `packages/synergy/src/storage/path.ts` when a collection name is uncertain; do not rely on an old directory diagram.

## Reconstruct the Invariants

Check independently:

- session info readability, Scope, parent/child lineage, workflow, and `pendingReply`
- root user message and assistant `rootID` / `parentID` semantics
- `visible`, `includeInContext`, message `origin`, and part `origin`
- tool-call/result pairing and terminal assistant state
- inbox `mode` (`task`, `steer`, or `context`)
- compaction anchor and continuation summary
- session indexes versus readable on-disk records
- migration log entries for the owning domain

Use `MessageV2.deriveSemantics()` and `MessageV2.isSystemPart()` when writing diagnostic code. Do not re-derive canonical semantics from retired booleans.

## Protect Data

Never hand-edit a live session, copy only part of its directory tree, or delete an index to make an error disappear. Use session export/import, recovery repair, migrations, or domain APIs for changes. Stop the isolated target runtime before any raw backup; copy `library.db` only with a consistent SQLite backup workflow.

Redact session content, absolute paths, credentials, and IDs before sharing evidence.

## Report

Return the target home/Scope, commands and records inspected, violated invariant, affected indexes or messages, repair preview, and the safest supported next action.
