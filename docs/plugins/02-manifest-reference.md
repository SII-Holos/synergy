# Plugin Manifest Reference

`plugin.json` is the distributable manifest. It is validated by `packages/plugin/src/manifest.ts`.

## Required Fields

```jsonc
{
  "name": "my-plugin",
  "version": "0.1.0",
  "description": "What this plugin does",
  "engines": {
    "synergy": ">=1.1.26",
  },
}
```

`name` is the canonical plugin id and must match `PluginDescriptor.id`.
`engines.synergy` is the only Synergy version contract. Synergy rejects installation when the current runtime does not satisfy the declared range.

## Runtime Entry

```jsonc
{
  "main": "./src/index.ts",
}
```

During `synergy-plugin build`, the runtime entry is bundled to `dist/runtime/index.js` and the packaged manifest is rewritten to:

```jsonc
{
  "main": "./runtime/index.js",
}
```

## Permissions

```jsonc
{
  "permissions": {
    "tools": {
      "filesystem": "none",
      "network": false,
      "shell": false,
      "mcp": "none",
    },
    "data": {
      "session": "none",
      "workspace": "none",
      "config": "none",
      "secrets": "none",
    },
    "network": {
      "connectDomains": [],
      "resourceDomains": [],
      "frameDomains": [],
    },
    "ui": {
      "toolRenderers": false,
      "partRenderers": false,
      "workspacePanels": false,
      "globalPanels": false,
      "settings": false,
      "themes": false,
      "icons": false,
      "routes": false,
      "trustedImport": false,
      "sandboxIframe": false,
    },
  },
}
```

`data.config` may be `none`, `plugin`, or `global`. Use `none` when the plugin does not read Synergy plugin config.

Per-tool capabilities live under `contributes.tools[].capabilities` and are merged with plugin-wide defaults.
Unknown permission and capability keys are rejected during manifest validation.

## Runtime Tool Contributions

```jsonc
{
  "contributes": {
    "tools": [
      {
        "name": "greet",
        "title": "Greet",
        "description": "Greet a user",
        "exposure": { "mode": "resident" },
        "display": { "kind": "default" },
        "capabilities": {
          "filesystem": "none",
          "network": false,
          "shell": false,
        },
      },
    ],
  },
}
```

`exposure` is optional and defaults to `{ "mode": "resident" }` for backward compatibility. Use
`{ "mode": "group", "group": "plugin:my-plugin", "title": "My Plugin", "description": "...", "whenToExpand": "..." }`
for related low-frequency tools that should be expanded together. Use
`{ "mode": "search", "title": "...", "keywords": ["..."] }` for rare individual tools that should be
discoverable through `search_tools` and activated explicitly with `expand_tools`. Use
`{ "mode": "internal" }` for helper tools that should never be offered to the primary agent or discovered
through `search_tools`; internal tools can only run when Synergy explicitly enables them for a delegated
subagent or another host-controlled flow.

`synergy-plugin validate --runtime-discovery` imports the descriptor, calls `init()`, reads returned runtime tools, and compares them with `contributes.tools`.

### Tool Display

`contributes.tools[].display` describes host-rendered presentation behavior. It must match the runtime tool definition when the tool uses a non-default display:

```jsonc
{
  "name": "generate_image",
  "description": "Generate an image",
  "display": {
    "kind": "media-generation",
    "visibility": "media",
    "presentation": "artifact-only",
    "media": {
      "type": "image",
      "aspectRatio": "1:1",
    },
  },
}
```

- `kind: "media-generation"` uses Synergy's built-in image/video/audio generation placeholder while the tool is running.
- `visibility: "media"` hides running and completed success states from the ordinary tool transcript so the media surface owns the experience.
- `media.actionLabel` and `media.pendingTitle` are optional accessibility/status labels. The host does not display tool arguments as user-visible transcript text.
- `presentation: "artifact-only"` promotes returned `attachments` into the final answer area.
- `primaryAttachmentIds` may be returned from `metadata.display` at runtime to choose which attachment ids are promoted.
- Error states are never hidden.

### Delegated Task Permission

Plugins that call `context.task.run()` must declare the task permission under `permissions.tools`:

```jsonc
{
  "permissions": {
    "tools": {
      "task": {
        "agents": ["my-plugin-planner"],
        "maxRuntimeMs": 30000,
      },
    },
  },
}
```

`task: true` allows delegation to any visible subagent, but marketplace plugins should prefer an explicit
agent allowlist. At runtime Synergy still uses the existing Cortex task flow and existing `task` permission;
`visibility: "hidden"` hides the delegated task from the ordinary chat step list and SubagentDock but preserves
audit/session data. If `output.mode: "structured"` is passed to `context.task.run()`, Cortex validates the child
result into `task.outputResult` without changing the normal trajectory-summary `task.result`.

## UI Contributions

```jsonc
{
  "contributes": {
    "ui": {
      "entry": "./dist/ui/index.js",
      "minUIApiVersion": "2.0.0",
      "toolRenderers": [{ "tool": "greet", "exportName": "default" }],
      "partRenderers": [{ "type": "custom-part", "exportName": "CustomPart" }],
      "workspacePanels": [{ "id": "panel", "label": "Panel", "icon": "layout-panel-left" }],
      "globalPanels": [{ "id": "global", "label": "Global", "icon": "globe" }],
      "settings": [{ "id": "settings", "label": "Settings", "icon": "settings", "group": "plugins" }],
      "chatComponents": [{ "id": "chat", "slot": "after-tools", "exportName": "ChatComponent" }],
      "themes": [{ "id": "theme", "label": "Theme", "path": "./themes/default.css" }],
      "icons": [{ "name": "logo", "path": "./icons/logo.svg" }],
      "routes": [{ "path": "/plugins/my-plugin", "entry": "default", "label": "My Plugin" }],
      "commands": [{ "id": "run", "label": "Run", "exportName": "runCommand" }],
    },
  },
}
```

`entry` is the built JavaScript bundle loaded by the Web host. The normal source path is `src/ui.tsx`; build writes it to the manifest entry path.

The Web host currently registers all schema-declared surfaces listed above. Internal API calls should use generated SDK methods; asset/script URLs remain browser-native.

## Packaged Output

After build and pack:

```text
dist/
  plugin.json
  runtime/index.js
  ui/index.js
  permissions.summary.json
  integrity.json
  assets/
  themes/
  icons/
my-plugin-0.1.0.synergy-plugin.tgz
```
