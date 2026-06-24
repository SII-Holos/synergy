# Plugin Toolchain

**Audience:** Plugin developers
**Source of truth:** `packages/synergy/src/cli/cmd/plugin-{create,build,pack,sign,publish,dev,validate}.ts`

---

All commands are subcommands of `synergy plugin`:

```bash
synergy plugin <command> [options]
```

## create — Scaffold a new plugin

```bash
synergy plugin create <name> [--template <template>]
```

Generates a complete project directory with `plugin.json`, `package.json`, `tsconfig.json`, and template source files.

| Template            | Use case                                             |
| ------------------- | ---------------------------------------------------- |
| `tool-ui` (default) | Tool definitions + SolidJS tool card renderer        |
| `workspace-panel`   | SolidJS workspace panel with no tools                |
| `api-connector`     | Network-enabled tools (fetchData, getJSON, postJSON) |
| `theme-icon`        | Theme and icon contributions only                    |

```bash
synergy plugin create my-plugin --template api-connector
cd my-plugin && bun install
```

Source: `packages/synergy/src/cli/cmd/plugin-create.ts:432`.

## dev — Development mode with file watching

```bash
synergy plugin dev [path] [--sandbox-preview]
```

Validates the manifest, prints permissions preview and runtime health snapshot, then watches `src/` for changes. On file change, re-validates the manifest and reloads plugin state.

```bash
synergy plugin dev --sandbox-preview
# → outputs sandbox iframe URLs for declared panels
```

Source: `packages/synergy/src/cli/cmd/plugin-dev.ts:269`.

## validate — Check manifest correctness

```bash
synergy plugin validate [path] [--runtime-discovery]
```

Validates `plugin.json` against the `PluginManifest` Zod schema. With `--runtime-discovery`, safely loads the plugin's runtime code in dev mode, collects registered tools, and compares them against the manifest's tool declarations.

```bash
synergy plugin validate --runtime-discovery
```

Source: `packages/synergy/src/cli/cmd/plugin-validate.ts:107`.

## build — Compile and normalize

```bash
synergy plugin build [path]
```

1. Validates the manifest.
2. Builds the backend entrypoint with `Bun.build` (target: bun).
3. Builds the frontend UI bundle with `Bun.build` (target: browser), if `contributes.ui.entry` exists.
4. Writes `dist/plugin.normalized.json` (canonical manifest).
5. Writes `dist/permissions.summary.json` (capability summary).
6. Copies `public/assets/` to `dist/assets/`.
7. Writes `dist/integrity.json` (SHA-256 hashes of runtime, UI, manifest, permissions).

```bash
synergy plugin build
```

Source: `packages/synergy/src/cli/cmd/plugin-build.ts:72`.

## pack — Package into tarball

```bash
synergy plugin pack [path]
```

Compresses `dist/` into `<name>-<version>.synergy-plugin.tgz`. Requires a successful build first (`dist/` must exist). Prints file size and SHA-256 integrity hash.

```bash
synergy plugin pack
# → Built v1.0.0 → my-plugin-1.0.0.synergy-plugin.tgz (24.5 KB)
#   Integrity: sha256-<hash>
```

Source: `packages/synergy/src/cli/cmd/plugin-pack.ts:24`.

## sign — Cryptographically sign a tarball

```bash
synergy plugin sign <tarball>
```

Hashes the tarball, extracts `plugin.normalized.json` and `permissions.summary.json`, hashes both, and signs the combined payload with an Ed25519 key. Outputs JSON signature metadata to stdout.

```bash
synergy plugin sign my-plugin-1.0.0.synergy-plugin.tgz
# → Signed my-plugin v1.0.0
#   Signer: a1b2c3d4e5f6...
```

Keys are stored at `~/.synergy/keys/signing-key.json`. Auto-generates a new keypair if none exists.

Source: `packages/synergy/src/cli/cmd/plugin-sign.ts:70`.

## publish — Submit to registry

```bash
synergy plugin publish <tarball>
```

Parses the tarball filename (`<name>-<version>.tar.gz`) and submits the metadata to the local registry at `http://localhost:3000`. See [marketplace.md](marketplace.md) for registry details.

Source: `packages/synergy/src/cli/cmd/plugin-publish.ts:35`.
