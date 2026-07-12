# Plugin Marketplace and Registry

The public Synergy Plugin Marketplace is a GitHub-backed aggregator. Each plugin owns its source repository and GitHub Release artifacts; the registry repository stores reviewed metadata that points to those artifacts.

Official index:

```text
https://raw.githubusercontent.com/SII-Holos/synergy-plugins/main/registry.json
```

Registry repository:

```text
https://github.com/SII-Holos/synergy-plugins
```

## Marketplace Configuration

Configuration belongs in `50-plugins.jsonc`:

```jsonc
{
  "pluginMarketplace": {
    "enabled": true,
    "registryUrl": "https://raw.githubusercontent.com/SII-Holos/synergy-plugins/main/registry.json",
    "includeLocalRegistry": true,
    "cacheTtlMs": 3600000,
    "offlineCache": true,
    "requestTimeoutMs": 10000,
    "artifactDownloadTimeoutMs": 60000,
    "cliRequestTimeoutMs": 120000,
  },
}
```

Remote indexes, detail records, and downloaded artifacts are cached under `~/.synergy/cache/plugin-market/`. The cache namespace is derived from `registryUrl`, so a custom registry does not overwrite the official cache. When `offlineCache` is enabled, stale verified metadata can support browsing during a network failure; installation still needs a valid cached or downloadable artifact.

## Official Publication

```bash
synergy-plugin publish-market --repo https://github.com/owner/my-plugin
```

The command validates, builds, packs, signs, prepares release assets, updates a registry checkout, rebuilds and validates its index, and opens a pull request when GitHub tooling is available. If upload, push, or PR creation cannot be automated, it prints the remaining commands.

`official` and `verified` are maintainer-reviewed registry labels. The authoring CLI does not grant them to a submission.

For a manual registry entry:

```bash
synergy-plugin build
synergy-plugin pack
synergy-plugin sign my-plugin-0.1.0.synergy-plugin.tgz
synergy-plugin entry my-plugin-0.1.0.synergy-plugin.tgz \
  --repo https://github.com/owner/my-plugin \
  --write-entry ../synergy-plugins/plugins/my-plugin.json
```

Then, in the registry checkout:

```bash
bun install
bun run build-registry
bun run validate
bun run build-registry --check
```

`entry` writes aggregator metadata; it does not upload a release or mutate the remote registry.

## Local Marketplace Testing

```bash
synergy plugin publish my-plugin-0.1.0.synergy-plugin.tgz
```

The local registry stores metadata at `~/.synergy/data/registry/plugins.json` and artifacts under `~/.synergy/data/registry/artifacts/<plugin-id>/<version>/`. Web Marketplace views can filter between the official and local sources.

## Registry Contract

The top-level `registry.json` is the list/search index. `plugins/<plugin-id>.json` contains versions, download and signature URLs, signer identity, integrity, manifest and permission hashes, risk, effective runtime metadata, compatibility, tools, and UI surface summaries.

These values must agree:

- registry ID and detail filename
- `plugin.json.name`
- runtime descriptor `id`
- signature plugin ID
- approval and lockfile ID

`engines.synergy` originates in the packaged manifest and is copied to the registry version's compatibility metadata.

## Verified Installation

Official installation follows this chain:

```text
registry version
  -> artifact download
  -> archive SHA-256
  -> registry-reviewed signer
  -> Ed25519 signature and payload hashes
  -> package and manifest inspection
  -> permission approval
  -> cached-artifact installation
```

Installation rejects a missing or invalid signature, unexpected signer, integrity mismatch, mismatched manifest hashes, ID/version mismatch, yanked version, unsafe path, or incomplete package. If consent is needed, the server returns the manifest, capability summary, risk, permission diff, and an artifact cache key; the approved retry reuses the verified cached artifact.

The archive must be the `.synergy-plugin.tgz` produced by the kit, not a source repository archive. It must include at least:

```text
plugin.json
runtime/index.js
integrity.json
permissions.summary.json
```

## Ownership Boundary

The registry reviews metadata, signer identity, and the distributable contract. The plugin repository remains responsible for source, releases, changelog, support, and vulnerability response. Signing proves which key produced an artifact; it does not prove the plugin is safe or correct. Review the requested capabilities and source before approving installation.
