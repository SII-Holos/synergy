# Plugin Marketplace

The Plugins workspace separates catalog discovery from installation state:

- **Discover** searches one registry source: Official or Local registry.
- **Installed** lists every configured plugin and its health, regardless of source.
- **Development** filters installed entries to directory registrations.

A directory plugin therefore appears in both Installed and Development. A package published to the local registry is a catalog entry, not a directory registration.

## Package Sources

Synergy accepts built local directories, `.synergy-plugin.tgz` archives, npm packages, git specs, URLs, built-ins, and official/local registry artifacts. Every source resolves to the same generated manifest and artifact contract before approval.

Directory resolution uses `dist/plugin.json` when a built project root is registered. Archives are inspected for unsafe paths before extraction. Remote package dependencies must already be bundled or declared in the packaged runtime; Synergy does not run dependency installation from manifest metadata.

## Official and Local Registries

The default official index is the reviewed `SII-Holos/synergy-plugins` GitHub registry. Its lightweight index links to per-plugin metadata and release artifacts. The local registry stores development catalog entries and artifacts under the configured Synergy home.

Registry identity, generated manifest ID, approval ID, lockfile key, signature plugin ID, and UI/runtime namespace must match.

When an official registry read cannot reach its upstream source and no cached data can satisfy the request, the server returns a structured `503 Service Unavailable` response. The Marketplace keeps installed or cached plugin details usable when possible, shows a registry-unavailable state instead of a generic application error, and offers an explicit retry action.

## Publish Flow

```bash
synergy-plugin build
synergy-plugin validate --runtime-discovery
synergy-plugin pack
synergy-plugin sign my-plugin-1.0.0.synergy-plugin.tgz
synergy-plugin publish-market --repo https://github.com/owner/my-plugin
```

`publish-market` prepares release/registry metadata and the official registry pull-request workflow. `entry` can generate metadata for a manual registry workflow. Official and verified labels are maintainer decisions; author tooling does not grant them.

Publishing is explicit. Build, validate, test, pack, local dev, and install do not mutate a remote registry.

## Install and Update Transaction

Installation follows this order:

1. resolve or stage the package;
2. read generated metadata without importing runtime code;
3. validate API version, contribution schema, artifact paths, hashes, signature, and registry identity;
4. compute the manifest and permission hashes and build an approval review when the exact artifact has not been approved;
5. submit approval through the server-authoritative `reviewToken` contract when required;
6. update the plugin config domain, lockfile, approval record, and incompatible-package record under the installation lock;
7. reload and verify exactly one plugin registration;
8. commit staged artifacts and remove rollback state.

Any failure restores the previous config, lockfile, approvals, incompatible records, artifact directory, and runtime view. Configured approval uses the same transaction and rollback path as install/update. Registry approval completes install or update through the existing upsert transaction. Upgrade lifecycle failure leaves the previous version active.

Old-format packages are recorded as incompatible and require reinstall. They are never loaded through a compatibility reader.

## Removal

Normal uninstall runs `lifecycle.uninstall` before changing registration state. Failure stops removal. A successful transaction removes every config spec that resolves to the canonical plugin ID, its lockfile entry, approval, plugin settings, incompatible records, and active runtime registration.

Force uninstall skips the lifecycle handler and may leave plugin-owned data. Plugin archives or registry caches that are not registration state may be retained for cache reuse and are reported by plugin doctor when invalid or orphaned.

Use `synergy plugin doctor` to inspect duplicate specs, stale lock entries, config drift, unresolved registrations, invalid caches, and invalid runtime state.
