# Plugin Manifest Reference

`plugin.json` is the distributable manifest. It is validated by `packages/plugin/src/manifest.ts`.

## Required Fields

```jsonc
{
  "name": "my-plugin",
  "version": "0.1.0",
  "description": "What this plugin does",
}
```

`name` is the canonical plugin id and must match `PluginDescriptor.id`.

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
      "invoke": true,
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
discoverable through `search_tools` and activated explicitly with `expand_tools`.

`synergy-plugin validate --runtime-discovery` imports the descriptor, calls `init()`, reads returned runtime tools, and compares them with `contributes.tools`.

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
