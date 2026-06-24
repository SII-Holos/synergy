# Plugin Marketplace And Registry

Synergy's current registry is local-first. The registry index lives at:

```text
~/.synergy/data/registry/plugins.json
```

Published plugin artifacts are copied under:

```text
~/.synergy/data/registry/artifacts/<pluginId>/<version>/
```

## Publish Flow

```bash
synergy plugin build
synergy plugin pack
synergy plugin sign my-plugin-0.1.0.synergy-plugin.tgz
synergy plugin publish my-plugin-0.1.0.synergy-plugin.tgz
```

`plugin publish` reads the packaged `plugin.json`, computes manifest and permission hashes, stores the real tarball artifact, computes `sha256-...` integrity, and publishes a registry version with a `downloadUrl` pointing to the stored artifact.

Registry entries use the plugin's canonical id:

```jsonc
{
  "id": "my-plugin",
  "name": "my-plugin",
  "versions": [
    {
      "version": "0.1.0",
      "downloadUrl": "file:///Users/me/.synergy/data/registry/artifacts/my-plugin/0.1.0/my-plugin-0.1.0.synergy-plugin.tgz",
      "integrity": "sha256-...",
      "manifestHash": "...",
      "permissionsHash": "...",
      "risk": "medium",
    },
  ],
}
```

## Install Flow

Marketplace install resolves the selected registry version and installs `version.downloadUrl` when present:

```text
registry detail -> selected version -> downloadUrl -> Plugin.add(downloadUrl)
```

Older registry entries that do not have `downloadUrl` fall back to `entry.name` or the registry id. New published entries should always include a real tarball URL and integrity.

Consent is never bypassed for registry installs. If the manifest requests capabilities that do not have a valid approval record, installation returns a consent-required response.

## Registry Routes

Current routes:

| Method | Route                                                  | Purpose                           |
| ------ | ------------------------------------------------------ | --------------------------------- |
| `GET`  | `/api/registry/plugins/search?q=`                      | Search registry entries           |
| `GET`  | `/api/registry/plugins/:id`                            | Full entry with all versions      |
| `GET`  | `/api/registry/plugins/:id/versions`                   | List versions                     |
| `GET`  | `/api/registry/plugins/:id/versions/:version`          | Version metadata                  |
| `GET`  | `/api/registry/plugins/:id/versions/:version/download` | Download the stored artifact      |
| `POST` | `/api/registry/plugins/publish`                        | Publish metadata                  |
| `POST` | `/api/plugins/install-from-registry`                   | Install selected registry version |

The app should use generated SDK methods for internal Synergy API calls. Browser-native loading remains appropriate for artifact, script, and asset URLs.

## Update Flow

Updates compare the installed manifest and approval record with the target registry version:

```text
installed manifest + approval -> registry version -> permission diff -> approve -> install artifact
```

The permission diff is keyed by canonical plugin id. A package name, registry display name, or tarball filename must not be used as the approval key.
