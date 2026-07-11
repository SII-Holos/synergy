# Plugin Manifest Reference

`plugin.json` is the declarative contract the host can inspect before importing plugin code. It is strict: unknown or malformed fields fail validation.

The TypeScript/Zod source of truth is `PluginManifest` from `@ericsanchezok/synergy-plugin`.

## Identity and Compatibility

| Field                                                             | Requirement                                                       |
| ----------------------------------------------------------------- | ----------------------------------------------------------------- |
| `name`                                                            | Canonical plugin ID, 1–128 characters; must equal descriptor `id` |
| `version`                                                         | Semantic version                                                  |
| `description`                                                     | Required, 1–1024 characters                                       |
| `author`, `homepage`, `repository`, `license`, `icon`, `keywords` | Optional marketplace/display metadata                             |
| `engines.synergy`                                                 | Supported Synergy range                                           |
| `engines.bun`                                                     | Optional Bun range                                                |
| `dependencies`                                                    | Optional map of plugin IDs to version ranges                      |
| `main`                                                            | Source runtime entry; defaults to `./src/index.ts`                |

`icon` can be a supported icon name or a packaged local SVG path. Marketplace publication requires a distributable icon when its review policy demands one.

## Permissions

Permissions declare the broad capability ceiling. Per-tool capabilities can narrow tool execution within that ceiling.

### Tool permissions

```jsonc
{
  "permissions": {
    "tools": {
      "filesystem": "none", // none | read | write
      "network": false,
      "shell": false,
      "mcp": "none", // none | invoke | spawn
      "task": {
        "agents": ["research-scout"],
        "maxRuntimeMs": 30000,
      },
    },
  },
}
```

`task` can be `true`, `false`, or a bounded allowlist. Marketplace plugins should declare the agents and maximum runtime they need.

### Data permissions

```jsonc
{
  "permissions": {
    "data": {
      "session": "metadata", // none | metadata | read
      "workspace": "read", // none | metadata | read
      "config": "plugin", // none | plugin | global
      "secrets": "own", // none | own
    },
  },
}
```

`config: "plugin"` permits the plugin's own namespace. `global` also requests global config write capability. Secret access is restricted to the plugin's own credential store.

### Network, UI, and hooks

```jsonc
{
  "permissions": {
    "network": {
      "connectDomains": ["api.example.com"],
      "resourceDomains": ["cdn.example.com"],
      "frameDomains": [],
    },
    "ui": true,
    "hooks": {
      "events": "selected",
      "eventNames": ["session.*", "note.updated"],
      "config": false,
      "toolExecute": "own",
      "permissionAsk": "none",
      "promptTransform": false,
      "compactionTransform": false,
    },
  },
}
```

Any `contributes.ui` block requires `permissions.ui: true`. Network domain lists constrain isolated bridge access and browser-loaded plugin resources/frames according to the owning surface.

## Contributions

### Tools

Each runtime tool must be declared:

```jsonc
{
  "name": "search",
  "title": "Search",
  "description": "Search the configured service",
  "icon": "search",
  "category": "research",
  "exposure": {
    "mode": "search",
    "keywords": ["lookup", "find"],
  },
  "display": {
    "kind": "default",
    "toolCard": "visible",
  },
  "capabilities": {
    "filesystem": "none",
    "network": true,
    "shell": false,
    "session": "none",
    "workspace": "metadata",
    "config": "plugin",
  },
}
```

`exposure.mode` is one of:

- `resident` — include directly in the active tool set
- `group` — place behind a named expandable group
- `search` — discover through tool search
- `internal` — make available only to host-controlled internal flows

`display.kind: "media-generation"` can declare image/video/audio placeholder and presentation metadata. See [Tools and delegation](tools-and-delegation.md).

### Skills

```jsonc
{
  "contributes": {
    "skills": [
      {
        "name": "my-workflow",
        "description": "Run the service workflow",
        "dir": "./skills/my-workflow",
      },
    ],
  },
}
```

The directory follows the Synergy skill layout (`SKILL.md`, optional `references/` and `scripts/`) and is packaged as a declared asset.

### Agents

Manifest agents declare name, description, mode (`subagent`, `primary`, or `all`), optional model/model role, hidden state, and permission overrides. The runtime descriptor supplies the actual prompt and richer agent behavior through its `agents` hook.

### MCP

`contributes.mcp` declares named local or remote MCP servers plus optional defaults. Lifecycle fields include eager/lazy/manual startup, required state, connect/list/call timeouts, retry, idle shutdown, tool filters, approval, output limits, and tool cache. `locked: true` prevents user override of the plugin declarations.

### Commands and config

`contributes.commands` advertises named commands and descriptions. The descriptor `cli` hook provides plugin-owned top-level CLI commands.

`contributes.config.schema` is JSON Schema for the plugin namespace and `defaults` supplies initial values. Runtime config writes are validated against the schema.

### UI

`contributes.ui` supports:

- tool and part renderers
- side/bottom workbench panels
- sidebar/page navigation
- declarative or Solid settings
- message and composer slots
- UI commands
- structured JSON themes and SVG icons

Solid surfaces require a built `.js` `entry` and `minUIApiVersion`. Declarative renderer fallbacks, form-schema settings, themes, and icons can exist without a JS entry when no Solid export is needed. See [UI contributions](ui-contributions.md).

Theme declarations use `{ id, label, path }`, where `path` references a packaged `.json` theme containing light and dark seed palettes plus optional canonical-token overrides. The Web host validates and resolves the asset; theme declarations cannot load arbitrary CSS. Plugins declaring structured themes must set `engines.synergy` to `>=2.4.4` or a narrower compatible range.

## Lifecycle and Runtime Preference

```jsonc
{
  "lifecycle": {
    "install": "bun run setup",
    "uninstall": "bun run cleanup",
    "update": "bun run migrate",
  },
  "runtime": {
    "mode": "process",
    "minRuntimeApiVersion": "1.0",
    "resources": {
      "memoryMb": 256,
      "startupTimeoutMs": 30000,
      "toolInvocationTimeoutMs": 120000,
      "hookInvocationTimeoutMs": 30000,
      "bridgeRequestTimeoutMs": 30000,
      "taskRunTimeoutMs": 120000,
      "shutdownGraceMs": 5000,
      "maxConcurrentRequests": 8,
      "maxLogBytesPerMinute": 1048576,
      "memoryPollIntervalMs": 1000,
      "heartbeatIntervalMs": 5000,
      "heartbeatMissesBeforeKill": 3,
    },
  },
}
```

The requested mode is a preference subject to host policy. Source trust, integrity, risk, and configured isolation can force a stricter mode or reject an unsafe request.

## Packaged Manifest

Build rewrites local paths to their packaged locations, writes both `plugin.json` and `plugin.normalized.json`, and copies declared assets without permitting absolute paths or `..` escapes.

An installable archive must contain:

```text
plugin.json
runtime/index.js
integrity.json
permissions.summary.json
```

Declared UI and static assets must also exist in the archive. Validation and installation reject missing runtime entries, identity mismatch, capability mismatch, unsafe asset paths, or incomplete packages.
