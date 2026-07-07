# Synergy Link Rebrand Migration Guide

## Summary

Version 2.0 renames MetaSynergy/meta-protocol to Synergy Link/synergy-link-protocol.
All `envID`/`env_` identifiers become `linkID`/`link_`. See below for per-consumer migration steps.

## Breaking Changes

### 1. Tool parameters: `envID` → `linkID`

- **bash tool**: `envID` → `linkID`. Old `backgroundAfterSeconds`/`timeoutSeconds` → `background`/`yieldSeconds`.
  Invalid or omitted `linkID` values run locally with a Synergy Link warning.
- **process tool**: `envID` → `linkID`. Same fallback behavior.
- **connect tool**: New tool name (replaces `remote_session`). Use `connect(action, linkID)` with actions: `open`, `close`, `status`, `list`.

### 2. Binary rename: `meta-synergy` → `synergy-link`

- Install dir: `~/.meta-synergy/bin/` → `~/.synergy-link/bin/`
- Env var: `META_SYNERGY_HOME` → `SYNERGY_LINK_HOME`
- Update PATH and any scripts referencing the old binary name.

### 3. Package rename

- `@ericsanchezok/meta-protocol` → `@ericsanchezok/synergy-link-protocol` (v2.0.0)
- `@ericsanchezok/meta-synergy` → `@ericsanchezok/synergy-link` (v2.0.0)

### 4. Protocol version v1 → v2

- Envelope `version` field: `1` → `2`
- Envelope field `envID` → `linkID`
- All schemas now use `.strict()` — reject unknown fields
- Error codes renamed: `env_not_found` → `link_not_found`, `env_inactive` → `link_inactive`, etc.
- Event bridge names: `meta.execution.request` → `synergy_link.execution.request`

### 5. State migration

- Legacy `~/.meta-synergy/` state is migrated to `~/.synergy-link/` on first startup.
- Old runtime must be stopped before migration.
- Legacy `envID` values with `env_` prefix are rewritten to `link_` prefix.
- Legacy credentials are migrated to shared auth and the old file is removed.

### 6. Enforcement gate (new)

- `shell_remote_execute` capability added for remote bash/process execution with valid `linkID`.
  Non-bypassable — profiles must explicitly allow remote execution.
- Autonomous mode: `network_request` denies `connect`; `shell_remote_execute` denies remote commands.

## Per-Consumer Migration

### Binary users

```bash
# Stop old runtime
meta-synergy stop
# Install new binary
curl -fsSL https://holosai.io/synergy-link/install | bash
# Start new runtime
synergy-link start
```

### Agent/script consumers

- Replace tool calls: `envID: "env_abc"` → `linkID: "link_abc"`
- Replace tool calls: `remote_session(...)` → `connect(action: "open", linkID: "...")`
- Remove `backgroundAfterSeconds` → use `background: true` or `yieldSeconds`
- Remove `timeoutSeconds` → commands auto-background; use process tool for timeout

### SDK consumers

- Update import: `@ericsanchezok/meta-protocol` → `@ericsanchezok/synergy-link-protocol`
- Update import: `@ericsanchezok/meta-synergy` → `@ericsanchezok/synergy-link`
- `SessionInboxItem.mode` → `SessionInboxItem.kind`

### Plugin authors

- `PluginEventHookInput`, `PluginConfigHookInput/Output`, `PluginChatSystemTransformInput` removed
- `config: true` permission removed from manifest schema
