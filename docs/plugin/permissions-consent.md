# Permissions & Consent

**Audience:** Plugin authors, operators
**Source of truth:** `packages/synergy/src/plugin/consent/` module, `packages/synergy/src/server/plugin-routes.ts`

---

## Manifest permissions

Plugins declare required permissions in `plugin.json`:

```jsonc
{
  "permissions": {
    "tools": {
      "shell": false, // Execute shell commands [high risk]
      "filesystem": false, // Read/write workspace files [medium-high]
      "network": false, // Outbound network requests [medium]
    },
    "data": {
      "session": "none", // "none" | "metadata" | "read"
      "workspace": "none", // "none" | "metadata" | "read"
      "config": "plugin", // "plugin" | "global"
      "secrets": false, // Credential store access [high]
    },
    "hooks": {
      "promptTransform": false, // Modify LLM prompts [high]
      "toolExecute": "none", // "none" | "own" | "declared" | "all"
      "permissionAsk": "none", // "none" | "own" | "all"
    },
  },
}
```

All fields default to safe values. Full schema: `packages/plugin/src/manifest.ts`.

## Diff computation

`diffPermissions()` compares two manifests (install or update):

- **New install:** all permissions are `added`, `requiresApproval` is `true`.
- **Update:** computes added, removed, unchanged, and changed (severity shift) permission sets.
- `requiresApproval` is `true` when there are additions, removals, severity changes, or risk changes.

Source: `packages/synergy/src/plugin/consent/diff.ts:14-115`.

The diff is exposed via API:

```bash
# Preview install
POST /api/plugins/preview-install  { manifest: {...} }

# Preview update
POST /api/plugins/:pluginId/preview-update  { manifest: {...} }
```

## Install/update approval flow

1. `synergy plugin add <spec>` installs the package and reads the manifest.
2. `evaluatePolicy()` checks configured rules (deny high-risk third-party, auto-approve builtin, require signature).
3. If policy does not auto-approve, the install throws requiring manual approval.
4. User runs `synergy plugin approve <pluginId>` which calls `POST /:pluginId/approve-install` or `POST /:pluginId/approve-update`.
5. `saveApproval()` persists a `PluginApprovalRecord` to `~/.synergy/data/plugin-approvals.json`.

Source: `packages/synergy/src/plugin/install.ts:49-287`, `packages/synergy/src/plugin/consent/approval-store.ts`.

## Approval policy config

Configure in `synergy.jsonc`:

```jsonc
{
  "pluginApprovalPolicy": {
    "allowUnsignedLocal": true,
    "autoApproveBuiltin": true,
    "denyHighRiskThirdParty": true,
    "requireSignatureForMarketplace": false,
  },
}
```

| Field                            | Default | Description                                           |
| -------------------------------- | ------- | ----------------------------------------------------- |
| `allowUnsignedLocal`             | `true`  | Allow unsigned local plugins with user consent        |
| `autoApproveBuiltin`             | `true`  | Auto-approve builtin plugins                          |
| `denyHighRiskThirdParty`         | `true`  | Block third-party plugins with high-risk capabilities |
| `requireSignatureForMarketplace` | `false` | Require cryptographic signature for non-local plugins |

Schema: `packages/synergy/src/config/schema.ts:973-1001`, policy evaluation: `packages/synergy/src/plugin/consent/policy.ts:30-88`.

## Audit log viewing

Every install, update, and policy decision is recorded in `~/.synergy/data/plugin-audit.json`.

```bash
# View all audit events
GET /api/plugins/:pluginId/audit

# Via CLI (planned)
synergy plugin audit [pluginId]
```

Audit event types: `install_requested`, `install_approved`, `install_blocked`, `update_requested`, `update_approved`, `update_blocked`, `update_failed_rolled_back`, `capability_denied`, `runtime_started`, `runtime_killed`, `runtime_crashed`.

Source: `packages/synergy/src/plugin/audit.ts`.
