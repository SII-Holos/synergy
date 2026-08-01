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

The default official index is the reviewed `SII-Holos/synergy-plugins` GitHub registry. Registry v2 removes plugin risk fields and records API/host compatibility plus natural-language `featuresSummary` and `permissionsSummary` fields for every version. Features explain what the plugin contributes; permissions separately explain which host access it requests. Synergy accepts both v1 and v2 while the registry rolls forward, normalizing v1 only at the network boundary. The local registry stores development catalog entries and artifacts under the configured Synergy home.

API2/API3 releases may remain in version history, but only non-yanked API4 versions are default installation candidates. A Plugin API 3 installation keeps its plugin ID and can update directly to a published API4 version without uninstalling first.

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

Marketplace package names and artifact basenames derive from `manifest.id`; `manifest.name` is human-readable display text and may differ without changing plugin identity.

plugin-kit signing, registry entry generation, host verification, and approval use the same canonical integrity contract exported by `@ericsanchezok/synergy-plugin/integrity`. A marketplace artifact is invalid when any participant derives either hash through a private payload or serializer.

## Install and Update Transaction

Installation follows this order:

1. resolve or stage the package;
2. read generated metadata without importing runtime code;
3. validate API version, contribution schema, artifact paths, hashes, signature, and registry identity;
4. verify the manifest and permission hashes, then compare the new structured grant with the saved publisher/grant record;
5. continue automatically for an official verified first install or same-publisher equal/narrower update; otherwise submit the server-authoritative `reviewToken` confirmation;
6. update the plugin config domain, lockfile, approval record, and incompatible-package record under the installation lock;
7. reload and verify exactly one plugin registration;
8. commit staged artifacts and remove rollback state.

Any failure restores the previous config, lockfile, approvals, incompatible records, artifact directory, and runtime view. Configured approval uses the same transaction and rollback path as install/update. Registry approval completes install or update through the existing upsert transaction. Upgrade lifecycle failure leaves the previous version active.

Plugin API 3 packages are recorded as incompatible and remain disabled until an API4 update is installed. Existing API4 artifacts use the frozen V4 decoder and remain loadable across later Synergy releases; they do not require repacking, reinstalling, or reapproval solely because the host changed.

## Removal

Normal uninstall runs `lifecycle.uninstall` before changing registration state. Failure stops removal. A successful transaction removes every config spec that resolves to the canonical plugin ID, its lockfile entry, approval, plugin settings, incompatible records, and active runtime registration.

Force uninstall skips the lifecycle handler and may leave plugin-owned data. Plugin archives or registry caches that are not registration state may be retained for cache reuse and are reported by plugin doctor when invalid or orphaned.

Use `synergy plugin doctor` to inspect duplicate specs, stale lock entries, config drift, unresolved registrations, invalid caches, and invalid runtime state.
