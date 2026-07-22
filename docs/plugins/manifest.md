# Generated Plugin Manifest

`dist/plugin.json` is a pure-data build artifact. `definePlugin()` is its only source. Authors must not edit or maintain a source manifest.

## Top-Level Shape

```jsonc
{
  "manifestVersion": 1,
  "apiVersion": "3.0",
  "id": "my-plugin",
  "name": "My Plugin",
  "version": "1.0.0",
  "description": "Example",
  "capabilities": [{ "id": "workspace.read" }],
  "contributions": [],
  "artifacts": {
    "generation": "content-derived-generation",
    "runtime": { "entry": "runtime/index.js", "sha256": "..." },
    "ui": { "entry": "ui/index.js", "sha256": "..." },
  },
}
```

Identity and descriptive fields come from `definePlugin()`. `capabilities` is the approved ceiling for Synergy Host Services. `contributions` is the handler-free form of the flat source list. `artifacts` and `generation` come from the build.

## Contribution Kinds

| Kind                    | Executable | Important generated fields                                                   |
| ----------------------- | ---------- | ---------------------------------------------------------------------------- |
| `operation`             | yes        | `type`, `expose`, input/output JSON Schema, optional timeout                 |
| `event`                 | no         | payload JSON Schema                                                          |
| `tool`                  | yes        | object input JSON Schema, exposure, display metadata, optional `enabledWhen` |
| `hook`                  | yes        | host hook point and priority                                                 |
| `agent`                 | no         | agent declaration                                                            |
| `skill`                 | no         | skill declaration                                                            |
| `mcp`                   | no         | MCP server declaration                                                       |
| `authProvider`          | yes        | provider profile                                                             |
| `ui.workbenchPanel`     | no         | surface, cardinality, optional default resource and trusted component        |
| `ui.navigationItem`     | no         | placement and optional trusted component                                     |
| `ui.messageRenderer`    | no         | message type and optional trusted component                                  |
| `ui.composerAction`     | no         | slot and optional trusted component                                          |
| `ui.composerExtension`  | no         | ordered trusted headless Composer lifecycle                                  |
| `ui.selectionExtension` | no         | ordered trusted headless selection lifecycle                                 |
| `ui.textAction`         | no         | host-rendered selected-text action and command operation reference           |
| `ui.messageSlot`        | no         | message slot, optional role filter, and trusted component                    |
| `ui.settings`           | no         | group, form schema, visibility, optional trusted component                   |
| `ui.theme`              | no         | label and packaged structured-theme JSON path                                |
| `ui.icon`               | no         | packaged SVG path                                                            |
| `lifecycle.upgrade`     | yes        | handler identity                                                             |
| `lifecycle.uninstall`   | yes        | handler identity                                                             |

Contribution IDs are unique across the whole plugin, not only within one kind. Every `requires` entry must name a top-level capability. Executable declarations require a runtime artifact. A trusted component requires a UI artifact.

## Schemas and Handlers

Source contributions may use Zod or JSON Schema. Build converts Zod to JSON Schema and removes handlers from the manifest. Tool input must compile to a top-level JSON Schema object. The generated object schema is canonical metadata: AJV-backed runtime validation does not round-trip it through Zod. Runtime startup reports protocol version, generation, and actual handler IDs. The host rejects missing, undeclared, or duplicate handlers.

Tools may declare a settings condition:

```ts
tool({
  id: "inspect",
  enabledWhen: { setting: "diagnosticsEnabled", equals: true },
  input: InspectInput,
  handler,
})
```

The referenced key must exist in the plugin's `ui.settings` object schema. The current Scope is filtered while tools are resolved and checked again by the dispatcher, so a stale model tool list cannot bypass the setting.

Multi-resource panels may define the resource opened by default:

```ts
workbenchPanel({
  id: "research",
  cardinality: "multi",
  defaultResource: { id: "map", title: "Research map", state: { view: "map" } },
  component: { source: "./src/ui/research.tsx" },
})
```

## Integrity

Every runtime and UI artifact has a SHA-256 hash in the manifest. `integrity.json` covers the generated manifest and packaged files. Synergy validates metadata, paths, and hashes before importing runtime code. Absolute paths, escaping `..` paths, missing declared assets, and tampered artifacts are rejected.

`ui.theme.path` must reference a packaged `.json` file accepted by the shared Synergy theme schema. `ui.icon.path` references a packaged SVG. Both are data contributions: they do not require a trusted component bundle.

The generated manifest does not contain dependency-install instructions, a duplicate permission tree, a runtime descriptor, or a hand-maintained contribution map.
