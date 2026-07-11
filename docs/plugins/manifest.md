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

| Kind                  | Executable | Important generated fields                                   |
| --------------------- | ---------- | ------------------------------------------------------------ |
| `operation`           | yes        | `type`, `expose`, input/output JSON Schema, optional timeout |
| `event`               | no         | payload JSON Schema                                          |
| `tool`                | yes        | description, input JSON Schema, exposure, display metadata   |
| `hook`                | yes        | host hook point and priority                                 |
| `agent`               | no         | agent declaration                                            |
| `skill`               | no         | skill declaration                                            |
| `mcp`                 | no         | MCP server declaration                                       |
| `authProvider`        | yes        | provider profile                                             |
| `ui.workbenchPanel`   | no         | surface, cardinality, optional trusted component             |
| `ui.navigationItem`   | no         | placement and optional trusted component                     |
| `ui.messageRenderer`  | no         | message type and optional trusted component                  |
| `ui.composerAction`   | no         | slot and optional trusted component                          |
| `ui.settings`         | no         | group, form schema, visibility, optional trusted component   |
| `ui.theme`            | no         | label and packaged structured-theme JSON path                |
| `ui.icon`             | no         | packaged SVG path                                            |
| `lifecycle.upgrade`   | yes        | handler identity                                             |
| `lifecycle.uninstall` | yes        | handler identity                                             |

Contribution IDs are unique across the whole plugin, not only within one kind. Every `requires` entry must name a top-level capability. Executable declarations require a runtime artifact. A trusted component requires a UI artifact.

## Schemas and Handlers

Source contributions may use Zod or JSON Schema. Build converts Zod to JSON Schema and removes handlers from the manifest. Runtime startup reports protocol version, generation, and actual handler IDs. The host rejects missing, undeclared, or duplicate handlers.

## Integrity

Every runtime and UI artifact has a SHA-256 hash in the manifest. `integrity.json` covers the generated manifest and packaged files. Synergy validates metadata, paths, and hashes before importing runtime code. Absolute paths, escaping `..` paths, missing declared assets, and tampered artifacts are rejected.

`ui.theme.path` must reference a packaged `.json` file accepted by the shared Synergy theme schema. `ui.icon.path` references a packaged SVG. Both are data contributions: they do not require a trusted component bundle.

The generated manifest does not contain dependency-install instructions, a duplicate permission tree, a runtime descriptor, or a hand-maintained contribution map.
