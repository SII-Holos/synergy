# Plugin Marketplace And Registry

Synergy's public Plugin Marketplace is a GitHub-backed aggregator. It does not require a deployed registry server.

The official registry index is:

```text
https://raw.githubusercontent.com/SII-Holos/synergy-plugins/main/registry.json
```

The registry repository is:

```text
https://github.com/SII-Holos/synergy-plugins
```

Each plugin keeps its own source repository and GitHub Release artifacts. The aggregator repository stores reviewed metadata only.

## Configuration

Marketplace configuration belongs in the `50-plugins.jsonc` domain:

```jsonc
{
  "pluginMarketplace": {
    "enabled": true,
    "registryUrl": "https://raw.githubusercontent.com/SII-Holos/synergy-plugins/main/registry.json",
    "includeLocalRegistry": true,
    "cacheTtlMs": 300000,
    "offlineCache": true,
  },
}
```

Synergy caches the official index under:

```text
~/.synergy/cache/plugin-market/registries/<registry-hash>/registry.json
~/.synergy/cache/plugin-market/registries/<registry-hash>/entries/<pluginId>.json
```

The cache namespace is derived from `pluginMarketplace.registryUrl`, so custom registries do not overwrite the official cache.

Stale cache may be used for browsing when `offlineCache` is enabled. Installation still requires a downloadable artifact unless it was already cached during the approval flow.

## Official Publish Flow

Plugin authors publish through GitHub PR review:

```bash
synergy-plugin publish-market \
  --repo https://github.com/owner/my-plugin
```

`publish-market` validates, builds, packs, signs, uploads or checks GitHub Release assets, updates the local `SII-Holos/synergy-plugins` checkout, regenerates `registry.json`, runs registry validation, and opens a PR when `gh` is available. If GitHub upload, push, or PR creation cannot be automated, it leaves exact manual commands.

`official` and `verified` are maintainer review labels. The CLI does not grant them automatically for third-party submissions.

Advanced publish workflows can point the kit at another registry checkout or fork:

```bash
synergy-plugin publish-market \
  --registry-dir ../synergy-plugins \
  --registry-repo git@github.com:SII-Holos/synergy-plugins.git \
  --registry-github-repo SII-Holos/synergy-plugins \
  --registry-base-branch main
```

The same values can be supplied through `SYNERGY_PLUGIN_MARKET_REGISTRY_DIR`, `SYNERGY_PLUGIN_MARKET_REGISTRY_REPO`, `SYNERGY_PLUGIN_MARKET_GITHUB_REPO`, and `SYNERGY_PLUGIN_MARKET_BASE_BRANCH`.

For manual entry generation:

```bash
synergy-plugin build
synergy-plugin pack
synergy-plugin sign my-plugin-0.1.0.synergy-plugin.tgz
synergy-plugin entry my-plugin-0.1.0.synergy-plugin.tgz \
  --repo https://github.com/owner/my-plugin \
  --write-entry ../synergy-plugins/plugins/my-plugin.json
```

Then run this in the `SII-Holos/synergy-plugins` checkout:

```bash
bun install
bun run build-registry
bun run validate
bun run build-registry --check
```

Open a PR against `SII-Holos/synergy-plugins`. After CI and maintainer review pass, merging to `main` makes the plugin visible to all Synergy clients using the official registry URL.

`synergy-plugin entry` does not mutate the remote registry. It generates or updates the metadata entry needed for the aggregator PR.

## Local Publish Flow

The local development registry is still available for testing marketplace UX:

```bash
synergy plugin publish my-plugin-0.1.0.synergy-plugin.tgz
```

Local registry metadata lives at:

```text
~/.synergy/data/registry/plugins.json
```

Local artifacts are copied under:

```text
~/.synergy/data/registry/artifacts/<pluginId>/<version>/
```

The Web Marketplace exposes a source filter:

- `Official` reads the GitHub aggregator.
- `Local` reads the local development registry.

## Registry Entry Shape

`registry.json` is a lightweight index for list/search views. Detail files live at `plugins/<plugin-id>.json`.

An official detail entry points to real release artifacts:

```jsonc
{
  "schemaVersion": 1,
  "id": "my-plugin",
  "name": "my-plugin",
  "description": "My Synergy plugin",
  "repo": "https://github.com/owner/my-plugin",
  "author": { "name": "Owner" },
  "verified": false,
  "official": false,
  "keywords": ["synergy-plugin"],
  "versions": [
    {
      "version": "0.1.0",
      "downloadUrl": "https://github.com/owner/my-plugin/releases/download/v0.1.0/my-plugin-0.1.0.synergy-plugin.tgz",
      "signatureUrl": "https://github.com/owner/my-plugin/releases/download/v0.1.0/my-plugin-0.1.0.synergy-plugin.tgz.sig",
      "signature": {
        "algorithm": "ed25519",
        "signer": "<public-key-hex>",
      },
      "integrity": "sha256-...",
      "manifestHash": "...",
      "permissionsHash": "...",
      "risk": "medium",
      "runtimeMode": "process",
      "permissionsSummary": [],
      "tools": [],
      "uiSurfaces": [],
      "publishedAt": "2026-06-25T00:00:00.000Z",
    },
  ],
  "yankedVersions": [],
}
```

The plugin id, detail filename, `plugin.json.name`, signature `pluginId`, approval id, and registry id must all be the same canonical plugin id.
Synergy version requirements live only in the packaged `plugin.json` under `engines.synergy`; registry entries do not duplicate that contract.

Third-party plugins are signed by the plugin author. The registry entry records the author signer public key for each version, CI verifies the release signature with that key, and Synergy clients trust the signer only because it was reviewed through the official registry PR.

## Install Flow

Official installation resolves the selected registry source and version:

```text
registry detail -> selected version -> downloadUrl -> sha256 integrity -> registry-reviewed signer -> signature verification -> package inspection -> approval -> install cached artifact
```

The artifact must be an installable plugin tarball, not a source archive. It must contain:

```text
plugin.json
runtime/index.js
integrity.json
permissions.summary.json
```

Remote install rejects the artifact if:

- `integrity` does not match the downloaded tarball
- the signature is missing or invalid
- the signature signer does not match the registry-reviewed signer
- signature payload hashes do not match artifact, manifest, or permissions
- `plugin.json.name` or `plugin.json.version` does not match the registry entry
- the version is yanked
- required package files are missing

If approval is required, `POST /api/plugins/install-from-registry` returns `409` with `code: "approval_required"`, the manifest, capabilities, risk, diff, and artifact cache key. After the user approves, the same install request reuses the cached artifact.

## Registry Routes

Current routes:

| Method | Route                                 | Purpose                                   |
| ------ | ------------------------------------- | ----------------------------------------- |
| `GET`  | `/api/registry/search?q=&source=`     | Search official/local registry entries    |
| `GET`  | `/api/registry/:id?source=`           | Full entry with all versions              |
| `GET`  | `/api/registry/:id/versions?source=`  | List versions                             |
| `GET`  | `/api/registry/:id/versions/:version` | Version metadata                          |
| `GET`  | `/api/registry/:id/download/:version` | Download local stored artifact            |
| `POST` | `/api/registry/publish`               | Publish to the local development registry |
| `POST` | `/api/plugins/install-from-registry`  | Install selected registry version         |

Use generated SDK methods for internal Synergy API calls. Browser-native loading remains appropriate for artifact, script, and asset URLs.
