# Plugin Toolchain

**Source of truth:** `packages/synergy/src/cli/cmd/plugin-*.ts`

The supported plugin development flow is:

```bash
synergy plugin create <name> --template <template>
cd <name>
bun install
synergy plugin validate --runtime-discovery
synergy plugin build
synergy plugin pack
synergy plugin sign <name>-<version>.synergy-plugin.tgz
synergy plugin publish <name>-<version>.synergy-plugin.tgz
```

Local installation uses the same resolver as runtime loading:

```bash
synergy plugin add file:///absolute/path/to/plugin
synergy plugin add file:///absolute/path/to/plugin/src/index.ts
synergy plugin add file:///absolute/path/to/plugin-0.1.0.synergy-plugin.tgz
synergy plugin add npm-package-name
synergy plugin add github:owner/repo
```

## Descriptor Contract

Plugin runtime code exports a `PluginDescriptor` object:

```ts
import type { PluginDescriptor } from "@ericsanchezok/synergy-plugin"

export const plugin: PluginDescriptor = {
  id: "my-plugin",
  async init(input) {
    return {}
  },
}

export default plugin
```

`plugin.id` must match `plugin.json.name`. Validation and loading fail on mismatch.

## create

```bash
synergy plugin create <name> [--template tool-ui|workspace-panel|api-connector|theme-icon]
```

Generated projects include `plugin.json`, `package.json`, `tsconfig.json`, runtime source, and any template UI/assets.

Templates:

| Template          | Output                                                       |
| ----------------- | ------------------------------------------------------------ |
| `tool-ui`         | Runtime tool plus Solid tool renderer source at `src/ui.tsx` |
| `workspace-panel` | Workspace panel UI source at `src/ui.tsx`                    |
| `api-connector`   | Network-enabled runtime tools plus tool renderers            |
| `theme-icon`      | Theme CSS and SVG icon assets with no UI JS entry            |

## validate

```bash
synergy plugin validate [path] [--runtime-discovery]
```

Validation checks:

- manifest schema and required identity fields
- canonical plugin id consistency
- UI entry/export declarations
- runtime policy warnings
- declared tool capabilities
- with `--runtime-discovery`, the descriptor is imported, `init()` is called in a dev-safe context, and runtime tools are compared with `contributes.tools`

## dev

```bash
synergy plugin dev [path] [--sandbox-preview]
```

Development mode validates the manifest, prints permission and runtime previews, watches plugin source, and reloads plugin state on changes.

## build

```bash
synergy plugin build [path]
```

Build output is written to `dist/`:

- backend runtime bundle: `dist/runtime/index.js`
- normalized manifest: `dist/plugin.json`
- UI bundle: the path declared by `contributes.ui.entry`, normally `dist/ui/index.js`
- copied `public/assets`, `themes`, and `icons`
- `dist/permissions.summary.json`
- `dist/integrity.json`

`contributes.ui.entry` is a distributable JavaScript asset path. If it is declared, build looks for `src/ui.tsx`, `src/ui/index.tsx`, `src/ui.ts`, or `src/ui/index.ts` and compiles that source to the declared entry.

## pack

```bash
synergy plugin pack [path]
```

Creates `<name>-<version>.synergy-plugin.tgz` from `dist/`. The archive must contain installable runtime assets, `plugin.json`, UI assets, permission summary, and integrity metadata.

## sign

```bash
synergy plugin sign <tarball>
```

Signs the plugin archive metadata with the local Ed25519 signing key under `~/.synergy/keys/signing-key.json`.

## publish

```bash
synergy plugin publish <tarball>
```

Accepts `.synergy-plugin.tgz` or `.tgz`, inspects the packaged `plugin.json`, copies the real artifact to the local registry artifact store, computes `sha256-...` integrity, and publishes metadata with a `file://` download URL.

## Registry Install

The Web marketplace and `install-from-registry` route install the selected registry version's `downloadUrl` when present. Only older registry entries without an artifact URL fall back to package name/spec installation.
