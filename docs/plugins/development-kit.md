# Synergy Plugin Development Kit

The Synergy Plugin Development Kit is the supported toolset for building plugins outside the Synergy source repository.

## What It Includes

- Synergy CLI plugin commands:
  - `synergy plugin create`
  - `synergy plugin validate --runtime-discovery`
  - `synergy plugin dev`
  - `synergy plugin build`
  - `synergy plugin pack`
  - `synergy plugin sign`
  - `synergy plugin publish`
  - `synergy plugin add`
- `@ericsanchezok/synergy-plugin` runtime SDK.
- `@ericsanchezok/synergy-plugin/tool` helper APIs.
- `@ericsanchezok/synergy-plugin/ui` UI contribution types.
- Built-in plugin templates:
  - `tool-ui`
  - `workspace-panel`
  - `api-connector`
  - `theme-icon`
- Manifest validation and runtime discovery.
- Build, packaging, signing, local installation, and registry publishing flows.

## Recommended Setup

Plugin authors should install Synergy and create a standalone plugin project:

```bash
synergy plugin create my-plugin --template tool-ui
cd my-plugin
bun install
```

The generated plugin project depends on `@ericsanchezok/synergy-plugin`. It should not import from this Synergy monorepo or assume local workspace aliases.

## Canonical Workflow

```bash
synergy plugin validate --runtime-discovery
synergy plugin build
synergy plugin pack
synergy plugin sign my-plugin-0.1.0.synergy-plugin.tgz
synergy plugin publish my-plugin-0.1.0.synergy-plugin.tgz
```

During local development:

```bash
synergy plugin add file:///absolute/path/to/my-plugin
synergy plugin dev /absolute/path/to/my-plugin
```

## Source Checkout Is Not Required

Normal plugin development should not require cloning Synergy. A source checkout is only appropriate when changing or debugging the platform itself:

- plugin SDK internals
- plugin CLI implementation
- plugin loader or spec resolver
- runtime isolation runner/supervisor
- permission and approval enforcement
- marketplace publishing and installation routes
- Web UI contribution host
- generated SDK routes or OpenAPI metadata

If a plugin can be built using only the CLI, `plugin.json`, and `@ericsanchezok/synergy-plugin`, keep it outside this repository.

## Compatibility Rules

- Use `PluginDescriptor { id, name?, init() }`.
- Do not use legacy `definePlugin` or function-style descriptors.
- Keep descriptor id and manifest name identical.
- Use `tool` as the runtime hook key for tool definitions.
- Use `contributes.ui.entry` only for built JavaScript output.
- Run `validate --runtime-discovery` before packaging.
