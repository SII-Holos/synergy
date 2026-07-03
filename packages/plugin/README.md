# Synergy Plugin SDK

`@ericsanchezok/synergy-plugin` is the authoring SDK for Synergy plugins.

Plugins extend the Synergy server runtime and can also contribute Web UI surfaces through `plugin.json`. A plugin module exports an object descriptor with a canonical `id` and an `init()` method. The descriptor id, `plugin.json.name`, registry id, lockfile key, and approval key must all be the same canonical plugin id.

Plugin authors should use `@ericsanchezok/synergy-plugin-kit` and this SDK from a standalone plugin project. Cloning the Synergy source repository is only needed when changing or debugging the plugin platform itself.

## Recommended Flow

```bash
bunx @ericsanchezok/synergy-plugin-kit create my-plugin --template tool-ui
cd my-plugin
bun install
synergy-plugin dev
synergy-plugin validate --runtime-discovery
synergy-plugin publish-market
```

During local development you can also install directly:

```bash
synergy plugin add file:///absolute/path/to/my-plugin
```

## Runtime Descriptor

Every runtime entry exports a `PluginDescriptor` object:

```ts
import type { PluginDescriptor } from "@ericsanchezok/synergy-plugin"
import { tool } from "@ericsanchezok/synergy-plugin/tool"

export const plugin: PluginDescriptor = {
  id: "my-plugin",
  name: "My Plugin",
  async init(input) {
    return {
      tool: {
        greet: tool({
          description: "Greet a user by name",
          args: {
            name: tool.schema.string(),
          },
          async execute(args, context) {
            return {
              output: `Hello, ${args.name}. Session: ${context.sessionID}`,
            }
          },
        }),
      },
      async "session.turn.after"(event) {
        console.log("turn completed", event.sessionID)
      },
    }
  },
}

export default plugin
```

`plugin.json.name` must match `plugin.id`; Synergy fails validation or loading if they differ.

## Tool Results And Attachments

Tools can return user-facing files through `attachments`. Use the generated SDK `asset.upload()` route or the public `/asset` endpoint to upload binary data, then return the resulting `asset://...` URL. Do not import Synergy internal asset modules from a plugin.

For visual tools whose output belongs in the main answer area, hide the tool card and set presentation on the returned attachment:

```ts
return {
  output: "",
  metadata: {
    display: {
      toolCard: "hidden",
    },
  },
  attachments: [
    {
      id: partId,
      sessionID: context.sessionID,
      messageID: context.messageID,
      type: "attachment",
      mime: "image/svg+xml",
      filename: "result.svg",
      url: uploaded.url,
      presentation: { renderer: "image", size: "medium", crop: false },
      model: { mode: "summary", summary: "Generated SVG result." },
    },
  ],
}
```

Each attachment controls its own display with `presentation.hidden`, `presentation.renderer`, `presentation.size`, and `presentation.crop`. Omit `renderer` to let Synergy choose from the MIME type.

For image, video, or audio generation tools, declare the display protocol on the tool definition as well. This lets Synergy show its built-in media generation placeholder as soon as the tool starts, then replace it with the completed attachment in the original message order:

```ts
const mediaDisplay = {
  kind: "media-generation",
  toolCard: "hidden",
  media: {
    type: "image",
    aspectRatio: "1:1",
  },
} as const

tool({
  description: "Generate an image",
  display: mediaDisplay,
  args: {
    prompt: tool.schema.string(),
  },
  async execute(args, context) {
    // Upload the generated image, then return it with attachment-level presentation.
  },
})
```

Use `toolCard: "hidden"` for tools whose running and completed states belong on a dedicated surface instead of a tool card. Optional media labels are for accessibility and host-specific status surfaces; Synergy does not show tool input parameters as transcript copy.

## Internal Tools And Delegated Tasks

Plugins can register helper tools that are only available to a controlled delegated task by setting `exposure: { mode: "internal" }`. Internal tools are not visible to the primary agent, resident tool lists, grouped tools, or `search_tools`; Synergy can still enable them explicitly for a delegated subagent run.

```ts
tool({
  description: "Validate a private planning result",
  exposure: { mode: "internal" },
  args: {
    choice: tool.schema.string(),
  },
  async execute(args) {
    return { output: JSON.stringify({ choice: args.choice }) }
  },
})
```

Use `context.task.run()` when a public plugin tool needs Synergy's existing Cortex delegation flow. The host always fills `parentSessionID`, `parentMessageID`, and `executionRole: "delegated_subagent"`; plugins cannot forge those fields.

```ts
const plan = await context.task?.run({
  subagent: "my-plugin-planner",
  description: "Plan the plugin result",
  prompt: "Choose a valid plan and return JSON.",
  tools: {
    "*": false,
    "plugin__my-plugin__private_helper": true,
  },
  visibility: "hidden",
  timeoutMs: 120_000,
  output: {
    mode: "structured",
    schema: {
      type: "object",
      required: ["choice"],
      properties: {
        choice: { type: "string" },
      },
    },
    maxRepairTurns: 3,
  },
})
```

When `output.mode` is `structured`, Cortex validates the child task result against the schema and may run repair turns before completing. Cortex still stores its normal task trajectory summary in `task.result`; the structured value is returned to the plugin call site as `plan.outputResult.data`.

## Plugin Input

`init(input)` receives runtime services scoped to the active Synergy Scope:

```ts
type PluginInput = {
  client: ReturnType<typeof createSynergyClient>
  scope: unknown
  directory: string
  worktree: string
  serverUrl: URL
  $: BunShell
  pluginDir: string
  config: { get(): Promise<Record<string, unknown>>; set(values: Record<string, unknown>): Promise<void> }
  auth: { get(key: string): Promise<string | undefined>; set(key: string, value: string): Promise<void> }
  cache: { get<T>(key: string): Promise<T | undefined>; set(key: string, value: unknown, ttl?: number): Promise<void> }
}
```

For isolated worker/process plugins, these services are proxied through the host bridge and checked against the plugin approval record. Workspace file and shell bridge calls require an active plugin tool context; read plugin package assets directly from `input.pluginDir`.

## Manifest

Each distributable plugin has a root `plugin.json`:

```jsonc
{
  "name": "my-plugin",
  "version": "0.1.0",
  "description": "Example Synergy plugin",
  "main": "./src/index.ts",
  "engines": {
    "synergy": ">=2.4.3",
  },
  "permissions": {
    "tools": {
      "filesystem": "none",
      "network": false,
      "shell": false,
      "mcp": "none",
    },
  },
  "contributes": {
    "tools": [
      {
        "name": "greet",
        "title": "Greet",
        "description": "Greet a user by name",
        "display": {
          "kind": "default",
        },
        "capabilities": {
          "filesystem": "none",
          "network": false,
          "shell": false,
        },
      },
    ],
    "ui": {
      "entry": "./dist/ui/index.js",
      "toolRenderers": [{ "tool": "greet" }],
    },
  },
}
```

`contributes.ui.entry` is a runtime-loadable JavaScript asset. Source files such as `src/ui.tsx` are only build inputs. `synergy-plugin build` uses the conventional UI source path and writes the compiled bundle to the declared entry.

Session workbench UI uses `contributes.ui.workbenchPanels`. A workbench panel declares which surface it belongs to and how its tabs behave:

```jsonc
{
  "contributes": {
    "ui": {
      "entry": "./dist/ui/index.js",
      "workbenchPanels": [
        {
          "id": "build-log",
          "label": "Build Log",
          "icon": "terminal",
          "exportName": "BuildLogPanel",
          "surface": "bottom",
          "cardinality": "multi",
          "requiresSession": true,
        },
      ],
    },
  },
  "permissions": {
    "ui": {
      "workbenchPanels": true,
    },
  },
}
```

`surface` is `"side"` or `"bottom"`. `cardinality` is `"exclusive"` for one active panel on that surface, `"singleton"` for one tab per panel id, or `"multi"` for a new tab each time. `requiresSession` hides the panel until the user is in a concrete session. App panels remain separate under `contributes.ui.appPanels` and create top-level sidebar entries.

## UI Types

UI contribution types are exported separately:

```ts
import type {
  PluginToolRendererProps,
  PluginWorkbenchPanel,
  PluginPanelProps,
  PluginMessageSlotProps,
} from "@ericsanchezok/synergy-plugin/ui"
```

Supported UI surfaces are tool renderers, part renderers, workbench panels, app panels, settings sections, message slots, themes, icons, app routes, and commands. The Web client loads aggregated UI metadata with the generated SDK method `plugin.listUiContributions()`, which maps to `/plugin/ui/contributions`; plugin JS and assets are still loaded through browser-native asset URLs.

## Runtime Modes

Synergy resolves each plugin to one runtime mode:

- `in-process` for trusted local or built-in plugins.
- `worker` for isolated plugins that do not need a separate OS process.
- `process` for third-party, high-risk, or policy-forced isolation.

Worker and process plugins are started through Synergy's plugin runner. The runner imports the descriptor, calls `init()`, reports tools and hooks to the host, and proxies tool and hook calls over the runtime protocol.

## Packaging

`synergy-plugin build` writes a distributable `dist/` directory:

- `dist/plugin.json`
- `dist/runtime/index.js`
- `dist/ui/index.js` when UI entry is declared
- copied theme/icon/assets files
- `dist/permissions.summary.json`
- `dist/integrity.json`

`synergy-plugin pack` archives `dist/` into `<name>-<version>.synergy-plugin.tgz`. `synergy-plugin sign` writes `<tarball>.sig`. `synergy-plugin publish-market` prepares the official marketplace submission by uploading or checking GitHub Release assets, writing a `SII-Holos/synergy-plugins` entry with the signer public key and `compatibility.synergy` from `plugin.json` `engines.synergy`, regenerating the registry index, running registry validation, and opening a PR when `gh` is available.

For local marketplace UX testing, the Synergy runtime still provides `synergy plugin publish <tarball>` to publish into the local development registry.

## Exports

```ts
import type { PluginDescriptor, PluginInput } from "@ericsanchezok/synergy-plugin"
import { tool } from "@ericsanchezok/synergy-plugin/tool"
import type { BunShell } from "@ericsanchezok/synergy-plugin/shell"
import type { PluginToolRendererProps } from "@ericsanchezok/synergy-plugin/ui"
```
