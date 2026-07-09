# Plugin Manifest Reference

`plugin.json` is the distributable manifest. It is validated by `packages/plugin/src/manifest.ts`.

## Required Fields

```jsonc
{
  "name": "my-plugin",
  "version": "0.1.0",
  "description": "What this plugin does",
  "engines": {
    "synergy": ">=2.4.3",
  },
}
```

`name` is the canonical plugin id and must match `PluginDescriptor.id`.
`engines.synergy` is the package's Synergy version contract. Synergy rejects installation when the current runtime does not satisfy the declared range, and official marketplace entries copy the same range into `compatibility.synergy`.
The plugin kit scaffold uses `PLUGIN_PROTOCOL_MIN_SYNERGY_RANGE` from `@ericsanchezok/synergy-plugin` for this field.

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
    "ui": true,
    "hooks": {
      "events": "selected",
      "eventNames": [],
      "config": false,
      "toolExecute": "own",
      "permissionAsk": "none",
      "promptTransform": false,
      "compactionTransform": false,
    },
  },
}
```

`data.config` may be `none`, `plugin`, or `global`. It defaults to `none`; declare `plugin` or `global` only when the plugin reads Synergy configuration through plugin services. This is separate from `hooks.config`, which allows observing redacted runtime config snapshots.

`hooks.events` may be `none`, `selected`, or `all`. In selected mode, `hooks.eventNames` supports exact event names, `*`, and prefix wildcards ending in `.*` such as `session.*`.

`hooks.config: true` allows the plugin `config(input, output)` hook to receive redacted config snapshots on startup, plugin reload, and config reload. `input.source` is `startup`, `plugin_reload`, or `reload`; `input.changedFields` is present for config reload notifications.

`hooks.promptTransform: true` allows `experimental.chat.system.transform` and `experimental.chat.messages.transform`. The system transform hook runs in `budget` and `final` phases; use `input.phase` to avoid duplicate prompt injection.

Per-tool capabilities live under `contributes.tools[].capabilities` and are merged with plugin-wide defaults. Unknown permission and capability keys are rejected during manifest validation.

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
    "toolCard": "hidden",
    "media": {
      "type": "image",
      "aspectRatio": "1:1",
    },
  },
}
```

- `kind: "media-generation"` uses Synergy's built-in image/video/audio generation placeholder while the tool is running.
- `toolCard: "hidden"` keeps the tool card itself out of the transcript when another surface owns the experience.
- `media.actionLabel` and `media.pendingTitle` are optional accessibility/status labels. The host does not display tool arguments as user-visible transcript text.
- Returned `attachments` render at their original tool-call position when `toolCard` is hidden; each attachment controls its own display through `presentation`.
- Attachment `presentation` supports `hidden`, `renderer`, `size`, and `crop`. Omit `renderer` to let Synergy choose from the MIME type.
- Error states are hidden when `toolCard` is `hidden`; otherwise they render as normal tool cards.

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
result and returns the real payload as `result.output.value` when `result.output.mode === "structured"`.

## UI Contributions

```jsonc
{
  "contributes": {
    "ui": {
      "entry": "./dist/ui/index.js",
      "minUIApiVersion": "3.0",
      "toolRenderers": [{ "tool": "greet", "exportName": "default" }],
      "partRenderers": [{ "type": "custom-part", "exportName": "CustomPart" }],
      "workbenchPanels": [
        {
          "id": "panel",
          "label": "Panel",
          "icon": "layout-panel-left",
          "surface": "side",
          "cardinality": "singleton",
          "requiresSession": true,
        },
      ],
      "navigation": [
        {
          "id": "dashboard",
          "label": "Dashboard",
          "icon": "layout-dashboard",
          "placement": "sidebar",
          "exportName": "DashboardPanel",
          "order": 100,
        },
        {
          "id": "details",
          "label": "Details",
          "icon": "sparkles",
          "placement": "page",
          "exportName": "DetailsPage",
        },
      ],
      "settings": [{ "id": "settings", "label": "Settings", "icon": "settings", "group": "plugins" }],
      "messageSlots": [{ "id": "after-tools", "slot": "message.after-tools", "exportName": "AfterToolsSlot" }],
      "composerSlots": [{ "id": "composer-above", "slot": "composer.above", "exportName": "ComposerAbove" }],
      "themes": [{ "id": "theme", "label": "Theme", "path": "./themes/default.css" }],
      "icons": [{ "name": "logo", "path": "./icons/logo.svg" }],
      "commands": [{ "id": "run", "label": "Run", "exportName": "runCommand" }],
    },
  },
}
```

`entry` is the built Solid JavaScript bundle loaded by the Web host. The normal source path is `src/ui.tsx`; build writes it to the manifest entry path. `minUIApiVersion` is required whenever `entry` is present.

`permissions.ui: true` is required for all UI contributions. `themes` and `icons` may exist without `entry`; Solid-rendered surfaces such as navigation, settings components, workbench panels, message slots, composer slots, commands, part renderers, and tool renderers without fallback require `entry`.

`navigation` contributes app-level destinations. `placement: "sidebar"` creates a top-level sidebar entry and page at `/plugins/:pluginId/:navigationId`; `placement: "page"` creates the same route without a sidebar button.

`workbenchPanels` are session workspace panels for the side or bottom workbench. `messageSlots` render around timeline anchors such as `message.before-user`, `message.after-tools`, `message.after-message`, and `message.footer`. `composerSlots` render around composer anchors such as `composer.above`, `composer.toolbar.left`, and `composer.start-option`.

The Web host registers all schema-declared surfaces listed above. Internal API calls should use generated SDK methods; asset/script URLs remain browser-native.

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
