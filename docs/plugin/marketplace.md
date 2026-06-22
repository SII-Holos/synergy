# Plugin Marketplace

**Audience:** Plugin publishers, operators
**Source of truth:** `packages/synergy/src/server/plugin-registry-routes.ts`, `packages/synergy/src/server/plugin-routes.ts`

---

## Registry metadata

The local registry is stored at `~/.synergy/data/registry/plugins.json`. Each entry follows the `RegistryPluginEntry` schema:

```json
{
  "id": "my-plugin",
  "name": "My Plugin",
  "description": "Example plugin",
  "author": { "name": "Author", "email": "", "url": "" },
  "verified": false,
  "official": false,
  "keywords": ["synergy-plugin"],
  "compatibility": { "synergy": ">=1.0.0" },
  "versions": [
    {
      "version": "1.0.0",
      "manifestHash": "sha256:...",
      "permissionsHash": "sha256:...",
      "integrity": "sha256:...",
      "risk": "low",
      "permissionsSummary": [],
      "publishedAt": 1718000000000
    }
  ],
  "risk": "low",
  "trustTier": "sandbox",
  "runtimeMode": "process",
  "permissionsSummary": [],
  "uiSurfaces": [],
  "tools": [],
  "downloads": 0
}
```

Registry API endpoints:

| Method | Path                                                   | Description                  |
| ------ | ------------------------------------------------------ | ---------------------------- |
| `GET`  | `/api/registry/plugins/search?q=`                      | Search by keyword            |
| `GET`  | `/api/registry/plugins/:id`                            | Full entry with all versions |
| `GET`  | `/api/registry/plugins/:id/versions`                   | All published versions       |
| `GET`  | `/api/registry/plugins/:id/versions/:version`          | Specific version metadata    |
| `GET`  | `/api/registry/plugins/:id/versions/:version/download` | Download tarball             |

Source: `packages/synergy/src/server/plugin-registry-routes.ts`.

## Verified badge

Entries have two boolean flags:

- `verified` — Set to `true` for plugins whose integrity has been cryptographically verified against a known signing key. The trust module checks for a valid `plugin.sig` file during installation.
- `official` — Set to `true` for plugins published by the Synergy team. These are treated as `trusted-import` by the `decideTrust()` function regardless of source.

Source: `packages/synergy/src/plugin/trust.ts:54-57`.

## Publish flow

1. Build and pack: `synergy plugin build && synergy plugin pack`
2. Sign (optional): `synergy plugin sign my-plugin-1.0.0.synergy-plugin.tgz`
3. Publish: `synergy plugin publish my-plugin-1.0.0.synergy-plugin.tgz`

The publish command extracts metadata from the filename (`<name>-<version>.tar.gz`) and submits to `POST /api/registry/plugins/publish`. The registry stores the entry and its version history. Currently the registry is local-only; remote registry support is planned.

Source: `packages/synergy/src/cli/cmd/plugin-publish.ts:35`.

## Update flow

Updates go through the same consent pipeline as installs:

1. `synergy plugin update [id]` resolves the latest version for each plugin.
2. Before applying, it calls `POST /:pluginId/preview-update` to compute the permission diff.
3. If `requiresApproval` is true, the operator must approve: `synergy plugin approve <pluginId>`.
4. The update removes the old plugin, installs the new one, and records an audit event.

Source: `packages/synergy/src/cli/cmd/plugin.ts:380-500`.

## Rollback

On update failure, the CLI automatically restores the previous lockfile entry:

```
↩ Rolled back lockfile for my-plugin
```

Audit events record the failure: `update_failed_rolled_back` with the old and new versions and a flag indicating whether rollback succeeded.

For manual rollback, restore the previous entry in `~/.synergy/data/synergy-lock.json` and re-install the earlier version:

```bash
synergy plugin add my-plugin@1.0.0
```
