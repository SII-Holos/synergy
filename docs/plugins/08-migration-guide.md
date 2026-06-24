# Plugin Migration Guide

This guide covers migration to the current plugin API.

## Runtime Descriptor

Move runtime entrypoints to an object descriptor:

```ts
import type { PluginDescriptor } from "@ericsanchezok/synergy-plugin"

const plugin: PluginDescriptor = {
  id: "my-plugin",
  async init(input) {
    return {
      tool: {},
    }
  },
}

export default plugin
```

Set `plugin.json.name` to the same value as `plugin.id`.

## Manifest

Add required manifest fields:

```jsonc
{
  "name": "my-plugin",
  "version": "0.1.0",
  "description": "Migrated plugin",
  "main": "./src/index.ts",
}
```

Declare runtime tools under `contributes.tools` and their capabilities under each tool.

## UI Entry

Use a built JavaScript entry:

```jsonc
{
  "contributes": {
    "ui": {
      "entry": "./dist/ui/index.js",
    },
  },
}
```

Put source in `src/ui.tsx` or `src/ui/index.tsx`; `synergy plugin build` compiles it to the declared entry.

## Validation

Run:

```bash
synergy plugin validate --runtime-discovery
synergy plugin build
synergy plugin pack
```

Fix any identity mismatch, undeclared runtime tool, missing UI export, or capability warning before publishing.

## Installation

Use the canonical resolver:

```bash
synergy plugin add file:///absolute/path/to/plugin
synergy plugin add file:///absolute/path/to/plugin-0.1.0.synergy-plugin.tgz
```

Approvals are keyed by plugin id, not npm package name or tarball filename.
