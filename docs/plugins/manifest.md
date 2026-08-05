# Generated Plugin Manifest

`dist/plugin.json` is a pure-data build artifact. `definePlugin()` is its only source. Authors must not edit or maintain a source manifest.

## Top-Level Shape

```jsonc
{
  "manifestVersion": 1,
  "apiVersion": "4.0",
  "compatibility": { "synergy": ">=3.0.11" },
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

Identity, compatibility, and descriptive fields come from `definePlugin()`. `compatibility.synergy` is a semver range for the oldest host that implements every stable API4 feature used by that plugin; `definePlugin()` defaults it to the first GA API4 host. Raise the minimum only when adopting a later additive feature. `capabilities` is the approved ceiling for Synergy Host Services. `contributions` is the handler-free form of the flat source list. `artifacts` and `generation` come from the build.

`apiVersion: "4.0"` identifies the entire stable API4 family. The npm authoring packages follow the Synergy product release version, so their package major does not select the Plugin API family. Synergy reads `apiVersion` and `compatibility` before strict V4 decoding and before executable import. Early pre-GA API4 artifacts that omitted `compatibility` receive the API4 base range at the decoder boundary.

## Contribution Kinds

| Kind                    | Executable | Important generated fields                                                   |
| ----------------------- | ---------- | ---------------------------------------------------------------------------- |
| `operation`             | yes        | `type`, `expose`, input/output JSON Schema, optional timeout                 |
| `event`                 | no         | payload JSON Schema                                                          |
| `tool`                  | yes        | object input JSON Schema, exposure, display metadata, optional `enabledWhen` |
| `cli.command`           | yes        | description, typed options, optional timeout                                 |
| `hook`                  | yes        | host hook point and priority                                                 |
| `agent`                 | no         | agent declaration                                                            |
| `skill`                 | no         | skill declaration                                                            |
| `mcp`                   | no         | MCP server declaration and optional `enabledWhen`                            |
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
| `lifecycle.install`     | yes        | post-commit fresh-install handler identity                                   |
| `lifecycle.upgrade`     | yes        | handler identity                                                             |
| `lifecycle.uninstall`   | yes        | handler identity                                                             |

Contribution IDs are unique within a contribution kind. This permits a command operation and its declarative UI action to share one meaningful local ID while their kind-qualified identities remain distinct. Every `requires` entry must name a top-level capability. Executable declarations require a runtime artifact. A trusted component requires a UI artifact.

## Schemas and Handlers

Source contributions may use Zod or JSON Schema. Build converts Zod to JSON Schema and removes handlers from the manifest. Tool input must compile to a top-level JSON Schema object. The generated object schema is canonical metadata: AJV-backed runtime validation does not round-trip it through Zod. Runtime startup reports protocol version, generation, and actual handler IDs. The host rejects missing, undeclared, or duplicate handlers.

Tools and MCP servers may declare a settings condition:

```ts
tool({
  id: "inspect",
  enabledWhen: { setting: "diagnosticsEnabled", equals: true },
  input: InspectInput,
  handler,
})

mcp({
  id: "components",
  enabledWhen: { setting: "componentsEnabled", equals: true },
  server: { type: "local", command: ["frontend-mcp"], startup: "eager" },
})
```

The referenced key must exist in the plugin's `ui.settings` object schema. Schema defaults apply before a value is stored. The current Scope filters gated tools during resolution and checks them again at dispatch; settings changes atomically replace the plugin's complete MCP server set.

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
