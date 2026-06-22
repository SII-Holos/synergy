# Tool Renderer Guide

Custom tool card renderers let your plugin replace the default tool result display in chat with a purpose-built SolidJS component. Instead of showing plain text output or a generic card, your renderer can render images, charts, interactive controls, or any other UI.

---

## What tool renderers are

Every time an agent invokes a tool (built-in or plugin-provided), the Web client displays the result in a **tool card**. By default, tools without a registered renderer show a `SmartTool` card — a generic collapsible with an auto-classified icon, title, and the raw text output.

A **tool renderer** is a SolidJS component that replaces this generic card with your own UI. The renderer receives the tool's input arguments, output text, metadata, and status so it can render the result in whatever way makes sense for your tool.

### When to write a tool renderer

| Scenario                                   | Default behavior                          | With a custom renderer                      |
| ------------------------------------------ | ----------------------------------------- | ------------------------------------------- |
| Tool returns an image URL                  | Shows a text link or file attachment card | Renders the image prominently inline        |
| Tool returns structured data               | Shows raw JSON or markdown                | Renders a table, chart, or form             |
| Tool returns a code diff                   | Shows plain text                          | Renders a side-by-side diff view            |
| Tool streams a long response               | Shows accumulating text                   | Shows a progress bar or streaming indicator |
| Tool has a periodic or status-based result | Shows the latest output text              | Shows status badges, timers, or progress    |

---

## How tool rendering works

The renderer lookup follows a fixed chain:

```
ToolRegistry.render(name)    → built-in tools only
  ↓ (miss)
externalLookup(name)         → plugin-registered renderers (triggers lazy load)
  ↓ (miss)
SmartTool                    → semantic auto-classification
  + fallbackMeta             → Tier 1 declarative override
  ↓ (miss)
GenericTool                  → plain "settings" gear icon with tool name
```

### The lookup chain in detail

1. **Built-in `ToolRegistry`** — Tools like `view_file`, `scan_files`, `revise_file`, `read`, and `grep` have hardcoded renderers in `tool-renders.tsx`. Plugin renderers never occupy this slot.

2. **External (plugin) lookup** — When a built-in renderer is not found, the bridge calls `getToolRenderer(name)`. This function (defined in `packages/app/src/plugin/registries/tool-registry.ts`) checks the plugin registry. If the renderer's `loader` function is set, it triggers an async dynamic import on first access. While the import is in flight, the lookup returns `undefined` — the chain falls through to the next step.

3. **SmartTool with fallback metadata** — `SmartTool` classifies the tool by name and input shape to pick an appropriate icon, title, and subtitle. If the plugin declared `fallback` metadata (icon, title, subtitleTemplate), those values override the auto-classified defaults.

4. **GenericTool** — The last-resort display: a gray gear icon and the raw tool name.

### Lazy loading flow

When a Tier 2 plugin registers a tool renderer with a `loader` (but no pre-resolved `render`), the system:

1. Shows the `SmartTool` with Tier 1 `fallbackMeta` immediately
2. Triggers the dynamic `import()` in the background
3. On completion, calls `notifyExternalToolLoaded()` which bumps a signal
4. The `createMemo` in the tool card re-evaluates and swaps in the real renderer

During the loading gap, the user sees a properly-labeled card (thanks to fallback metadata) rather than a blank or loading placeholder.

---

## Tier 2 (trusted): export a Solid component

Tier 2 plugins run in the same origin as the Web client. Their tool renderers are SolidJS components imported through a dynamic `import()` call.

### 1. Write the renderer component

Create a SolidJS component that accepts `PluginToolRendererProps`:

```tsx
// src/ui/meme-renderer.tsx
import type { Component } from "solid-js"
import type { PluginToolRendererProps } from "@ericsanchezok/synergy-plugin"

const MemeRenderer: Component<PluginToolRendererProps> = (props) => {
  const imageUrl = () => {
    const meta = props.metadata as Record<string, unknown>
    return meta.imageUrl as string | undefined
  }

  return (
    <div style={{ padding: "12px" }}>
      <h3 style={{ margin: "0 0 8px" }}>{props.title ?? "Meme"}</h3>
      {props.output && <p style={{ margin: "0 0 8px" }}>{props.output}</p>}
      {imageUrl() && (
        <img
          src={imageUrl()}
          alt={props.title ?? "Generated image"}
          style={{ maxWidth: "100%", borderRadius: "8px" }}
        />
      )}
    </div>
  )
}

export default MemeRenderer
```

The component receives these props:

| Prop            | Type                      | When populated                                                     |
| --------------- | ------------------------- | ------------------------------------------------------------------ |
| `input`         | `Record<string, unknown>` | Always — the arguments passed to the tool                          |
| `metadata`      | `Record<string, unknown>` | Always — from the tool result or intermediate state                |
| `tool`          | `string`                  | Always — the tool name                                             |
| `title`         | `string \| undefined`     | On completion — from `ToolResult.title`                            |
| `output`        | `string \| undefined`     | On completion — from `ToolResult.output`                           |
| `status`        | `string \| undefined`     | `"pending"`, `"running"`, `"generating"`, `"completed"`, `"error"` |
| `raw`           | `string \| undefined`     | During streaming — raw partial JSON input                          |
| `charsReceived` | `number \| undefined`     | During streaming — progressive character count                     |
| `hideDetails`   | `boolean \| undefined`    | When the tool card is collapsed                                    |
| `defaultOpen`   | `boolean \| undefined`    | Whether to start expanded                                          |
| `forceOpen`     | `boolean \| undefined`    | Force the card open regardless of user state                       |

### 2. Declare in the manifest

In `plugin.json`, add an entry to `contributes.ui.toolRenderers`:

```jsonc
{
  "contributes": {
    "ui": {
      "entry": "dist/ui/index.js",
      "toolRenderers": [
        {
          "tool": "send_meme",
          "exportName": "default",
          "priority": 0,
          "fallback": {
            "icon": "image",
            "title": "Send Meme",
            "subtitleTemplate": "{input.top_text} / {input.bottom_text}",
          },
        },
      ],
    },
  },
  "permissions": {
    "ui": {
      "toolRenderers": true,
      "trustedImport": true,
    },
  },
}
```

The `entry` field points at the compiled JS bundle served by the plugin assets endpoint. The `toolRenderers` array maps each tool name to its component export and optional fallback metadata.

### 3. The `entry` bundle

The `entry` file is a compiled JavaScript bundle that exports your renderer component. It is served by the server at:

```
/plugin/assets/<pluginId>/<version>/<entry>
```

Build your UI bundle separately from the server-side plugin code. For example, with a build step targeting the browser:

```bash
# Build the UI bundle (SolidJS JSX → JS)
bun build ./src/ui/index.tsx \
  --outdir ./dist/ui \
  --target browser \
  --splitting \
  --format esm
```

The resulting `dist/ui/index.js` is what `entry` references. The server serves the file with `Cache-Control: public, immutable, max-age=31536000`.

### 4. Registration via lifecycle

When the Web client starts, it fetches UI contributions from `GET /api/plugins/ui/contributions`. The lifecycle module (`packages/app/src/plugin/lifecycle.ts`) calls `activatePlugin()` for each contribution:

```ts
if (ui.toolRenderers) {
  for (const tr of ui.toolRenderers) {
    const dispose = registerToolRenderer({
      name: tr.tool,
      loader: isTrusted
        ? () =>
            loadPluginExport(contrib, tr.exportName ?? "default").then((c) => ({
              default: c as ToolRenderer,
            }))
        : undefined,
      fallback: tr.fallback,
    })
    disposers.push(dispose)
  }
}
```

Tier 2 plugins get a `loader` that calls `loadPluginExport`, which performs the dynamic `import()`. The `fallback` is always stored regardless of tier, so Tier 1 declarations work without any code execution.

---

## Tier 1 (declarative): just provide fallback metadata

Tier 1 plugins don't execute JavaScript in the client. They only declare `fallback` metadata in `plugin.json`. This metadata feeds into the `SmartTool` fallback chain, giving you control over the icon, title, and subtitle without writing any frontend code.

```jsonc
{
  "contributes": {
    "ui": {
      "toolRenderers": [
        {
          "tool": "my_tool",
          "fallback": {
            "icon": "globe",
            "title": "My Tool",
            "subtitleTemplate": "Query: {input.query}",
          },
        },
      ],
    },
  },
}
```

The renderer entry is **not** wired to any JavaScript import. The manifest toolRenderers entry exists only to carry `fallback` metadata. All tools still work in the chat — they just use `SmartTool` with your chosen icon and labeling instead of the auto-classified defaults.

### Fallback metadata fields

| Field              | Type                | Description                                                   | Example                          |
| ------------------ | ------------------- | ------------------------------------------------------------- | -------------------------------- |
| `icon`             | `string` (optional) | Lucide icon name for the tool card trigger                    | `"image"`, `"globe"`, `"search"` |
| `title`            | `string` (optional) | Display title shown in the card trigger                       | `"Send Meme"`                    |
| `subtitleTemplate` | `string` (optional) | Template with `{input.key}` and `{metadata.key}` placeholders | `"Top: {input.top_text}"`        |

### Template resolution

The `subtitleTemplate` supports dot-separated paths into `input` or `metadata` objects:

```jsonc
{
  "subtitleTemplate": "{input.directory}/{input.filePath}",
}
```

Prefix keys with `input.` for tool arguments and `metadata.` for result metadata. If a placeholder key is missing, it renders as-is (e.g., `"{input.missing}"`).

---

## Complete `send_meme` plugin example

This example walks through building a plugin that generates meme images server-side with `@napi-rs/canvas` and renders them prominently in the chat with a custom tool renderer.

### Project structure

```
send-meme-plugin/
├── plugin.json
├── package.json
├── src/
│   ├── index.ts          # Server-side plugin entry
│   ├── meme-generator.ts # @napi-rs/canvas image generation
│   └── ui/
│       ├── index.tsx     # UI bundle entry
│       └── meme-renderer.tsx  # SolidJS tool renderer component
└── dist/
    └── ui/
        └── index.js      # Compiled UI bundle
```

### 1. `plugin.json` — manifest

```jsonc
{
  "name": "send-meme-plugin",
  "version": "1.0.0",
  "description": "Generate meme images with custom top/bottom text",
  "minSynergyVersion": "2.0.0",
  "main": "./src/index.ts",
  "contributes": {
    "tools": [
      {
        "name": "send_meme",
        "description": "Generate a meme image with custom text overlaid on a template image",
      },
    ],
    "ui": {
      "entry": "dist/ui/index.js",
      "toolRenderers": [
        {
          "tool": "send_meme",
          "exportName": "default",
          "priority": 0,
          "fallback": {
            "icon": "image",
            "title": "Send Meme",
            "subtitleTemplate": "{input.top_text} / {input.bottom_text}",
          },
        },
      ],
    },
  },
  "permissions": {
    "ui": {
      "toolRenderers": true,
      "trustedImport": true,
    },
  },
}
```

### 2. `package.json`

```jsonc
{
  "name": "send-meme-plugin",
  "type": "module",
  "dependencies": {
    "@ericsanchezok/synergy-plugin": "^2.0.0",
    "@napi-rs/canvas": "^0.1.0",
    "zod": "^3.23.0",
  },
  "devDependencies": {
    "typescript": "^5.7.0",
    "solid-js": "^1.9.0",
  },
}
```

### 3. `src/index.ts` — server-side plugin

```ts
import type { Plugin } from "@ericsanchezok/synergy-plugin"
import { tool } from "@ericsanchezok/synergy-plugin/tool"
import { generateMeme } from "./meme-generator"

const SendMemePlugin: Plugin = {
  id: "send-meme",
  name: "Send Meme Plugin",
  async init(ctx) {
    return {
      tool: {
        send_meme: tool({
          description: "Generate a meme image by overlaying text on a template image",
          args: {
            template: tool.schema
              .enum(["drake", "distracted-bf", "change-my-mind", "doge"])
              .describe("Meme template to use"),
            top_text: tool.schema.string().describe("Text for the top portion of the meme"),
            bottom_text: tool.schema.string().optional().describe("Text for the bottom portion of the meme"),
          },
          async execute(args) {
            // Generate the meme image and write it to a temp file
            const { filePath, mime } = await generateMeme({
              template: args.template,
              topText: args.top_text,
              bottomText: args.bottom_text,
            })

            // Use the built-in Asset system to store the image
            const file = Bun.file(filePath)
            const buffer = Buffer.from(await file.arrayBuffer())
            const assetId = ctx.cache.write ? "TODO" : await ctx.client.uploadAsset(buffer, mime)
            // ^ In practice use Asset.write() from the runtime

            const imageUrl = `/asset/${assetId}`

            return {
              title: `${args.template} meme`,
              output: `Generated ${args.template} meme: "${args.top_text}"${args.bottom_text ? ` / "${args.bottom_text}"` : ""}`,
              metadata: {
                imageUrl,
                template: args.template,
                width: 800,
                height: 600,
              },
              attachments: [
                {
                  type: "file",
                  id: crypto.randomUUID(),
                  sessionID: ctx.scope.id,
                  messageID: "",
                  mime,
                  filename: `${args.template}-meme.png`,
                  url: `asset://${assetId}`,
                },
              ],
            }
          },
        }),
      },
    }
  },
}

export default SendMemePlugin
```

### 4. `src/meme-generator.ts` — image generation

```ts
import { createCanvas, loadImage, GlobalFonts } from "@napi-rs/canvas"
import path from "path"
import fs from "fs"

// Template configurations (background image path and text regions)
const TEMPLATES = {
  drake: { bg: "drake.png", topX: 400, topY: 180, bottomX: 400, bottomY: 520 },
  "distracted-bf": { bg: "distracted.png", topX: 200, topY: 140, bottomX: 600, bottomY: 140 },
  "change-my-mind": { bg: "change-my-mind.png", topX: 400, topY: 500, bottomX: 0, bottomY: 0 },
  doge: { bg: "doge.png", topX: 200, topY: 100, bottomX: 600, bottomY: 100 },
}

const FONT_PATH = path.join(import.meta.dir, "../assets/impact.ttf")
const TEMPLATE_DIR = path.join(import.meta.dir, "../assets/templates")

// Register the Impact font (or fall back to a system sans-serif)
try {
  GlobalFonts.registerFromPath(FONT_PATH, "Impact")
} catch {
  // Impact font not bundled — text rendering uses system sans-serif
}

export async function generateMeme(input: {
  template: keyof typeof TEMPLATES
  topText: string
  bottomText?: string
}): Promise<{ filePath: string; mime: string }> {
  const config = TEMPLATES[input.template]
  const bgPath = path.join(TEMPLATE_DIR, config.bg)
  const bg = await loadImage(bgPath)

  const canvas = createCanvas(bg.width, bg.height)
  const ctx = canvas.getContext("2d")

  // Draw background image
  ctx.drawImage(bg, 0, 0)

  // Configure text style
  const fontSize = Math.min(48, Math.floor(bg.width / Math.max(input.topText.length, input.bottomText?.length ?? 1)))
  ctx.font = `bold ${fontSize}px Impact, Arial, sans-serif`
  ctx.textAlign = "center"
  ctx.textBaseline = "middle"
  ctx.strokeStyle = "black"
  ctx.lineWidth = 3
  ctx.fillStyle = "white"

  // Helper to draw outlined text
  function drawOutlinedText(text: string, x: number, y: number) {
    ctx.strokeText(text.toUpperCase(), x, y)
    ctx.fillText(text.toUpperCase(), x, y)
  }

  // Draw top text
  drawOutlinedText(input.topText, config.topX, config.topY)

  // Draw bottom text
  if (input.bottomText) {
    drawOutlinedText(input.bottomText, config.bottomX, config.bottomY)
  }

  // Write to temp file
  const outDir = path.join(import.meta.dir, "../.cache")
  fs.mkdirSync(outDir, { recursive: true })
  const filePath = path.join(outDir, `${input.template}-${Date.now()}.png`)

  const buffer = canvas.toBuffer("image/png")
  fs.writeFileSync(filePath, buffer)

  return { filePath, mime: "image/png" }
}
```

> **Note on `@napi-rs/canvas`:** This library provides Node.js-compatible Canvas/SKIA rendering. It runs on the server side (not in the browser). The plugin runtime runs on Bun, which can load `@napi-rs/canvas` natively. For image generation on macOS, you may need `pkg-config` and `cairo` installed (`brew install pkg-config cairo pango`).

### 5. `src/ui/index.tsx` — UI bundle entry

```tsx
export { default as default } from "./meme-renderer"
```

### 6. `src/ui/meme-renderer.tsx` — SolidJS renderer component

```tsx
import type { Component } from "solid-js"
import { Show, createMemo } from "solid-js"
import type { PluginToolRendererProps } from "@ericsanchezok/synergy-plugin"

const MemeRenderer: Component<PluginToolRendererProps> = (props) => {
  const meta = createMemo(() => props.metadata as Record<string, unknown>)

  const imageUrl = createMemo(() => meta().imageUrl as string | undefined)
  const template = createMemo(() => meta().template as string | undefined)
  const dimensions = createMemo(() => ({
    width: (meta().width as number) ?? 800,
    height: (meta().height as number) ?? 600,
  }))

  return (
    <div data-component="meme-renderer" style={{ padding: "12px" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "8px",
          "margin-bottom": "8px",
        }}
      >
        <span
          style={{
            background: "var(--surface-brand-base, #b98522)",
            color: "white",
            padding: "2px 8px",
            "border-radius": "4px",
            "font-size": "11px",
            "font-weight": 600,
            "text-transform": "uppercase",
          }}
        >
          {template() ?? "meme"}
        </span>
        <span style={{ "font-size": "13px", color: "var(--text-weak, #6f6761)" }}>
          {dimensions().width}×{dimensions().height}
        </span>
      </div>

      <Show when={props.output}>
        <p style={{ margin: "0 0 8px", "font-size": "13px", color: "var(--text-base, #332e2b)" }}>{props.output}</p>
      </Show>

      <Show when={imageUrl()}>
        {(url) => (
          <img
            src={url()}
            alt={props.title ?? "Generated meme"}
            loading="lazy"
            style={{
              "max-width": "100%",
              height: "auto",
              "border-radius": "8px",
              border: "1px solid var(--border-base, rgba(31,0,0,0.16))",
              display: "block",
            }}
          />
        )}
      </Show>
    </div>
  )
}

export default MemeRenderer
```

### 7. Build the UI bundle

```bash
bun build ./src/ui/index.tsx \
  --outdir ./dist/ui \
  --target browser \
  --splitting \
  --format esm \
  --external solid-js
```

The `--external solid-js` flag prevents bundling SolidJS twice — the host application provides it.

### 8. Install and test

Place the plugin in `.synergy/plugin/` (project scope) or `~/.synergy/config/plugin/` (global):

```bash
cp -r send-meme-plugin ~/.synergy/config/plugin/send-meme-plugin
```

Start the server and connect:

```bash
bun dev
bun dev send "generate a drake meme with top text 'writing docs' and bottom text 'writing tests'"
```

The tool card will show:

1. **While loading** — `SmartTool` with the icon "image" and subtitle "writing docs / writing tests" (from `fallback`)
2. **After bundle loads** — the custom `MemeRenderer` component displaying the image prominently
3. **On completion with attachments** — the image also appears in the attachment strip below the tool card

---

## How attachments flow from tool result → frontend

Plugin tools that return `ToolResult` with an `attachments` array follow this pipeline:

```
Tool.execute()
  ↓
returns ToolResult { title, output, metadata, attachments }
  ↓
Server stores attachment files in the asset store (Asset.write)
  ↓
attachment.url uses "asset://<assetId>" scheme
  ↓
Server saves tool state including attachments in the session
  ↓
Client receives the completed tool part with attachments
  ↓
Tool card renders via the custom renderer or SmartTool
  ↓
Below the card, ToolAttachments renders the attachment strip
```

The `AttachmentList` component (in `packages/ui/src/components/attachment-card.tsx`) handles display:

- **Image attachments** (`mime.startsWith("image/")`) — render as clickable thumbnails that open in a lightbox
- **PDF attachments** — render as download cards with a preview icon
- **Other files** — render as download cards with file-type icons

For the `send_meme` example, the tool returns both `metadata.imageUrl` (for the custom renderer) and `attachments[].url` (for the standard attachment strip). The custom renderer reads from `metadata` to display the image inline, while the attachment strip below the card provides a standard interactive preview.

---

## Lazy loading behavior

When a Tier 2 plugin declares a tool renderer with a `loader` (no pre-resolved render function), the system shows the `SmartTool` fallback immediately while the bundle loads in the background.

### The loading sequence

```
Plugin activates → registerToolRenderer({ name, loader, fallback })
  ↓
User sends a message → agent invokes "send_meme"
  ↓
Client receives tool part → getToolRenderer("send_meme")
  ↓
state["send_meme"].render = undefined
state["send_meme"].loader = async function() { ... }
  ↓
Loader fires:  import("/plugin/assets/send-meme/1.0.0/dist/ui/index.js")
  ↓ (async — bundle may take 50-300ms to load)
Return SmartTool with fallbackMeta = { icon, title, subtitleTemplate }
  ↓
Bundle loads → mod.default = MemeRenderer
  ↓
setLoadedSignal(v => v + 1) → notifyExternalToolLoaded()
  ↓
createMemo in tool card re-evaluates → finds MemeRenderer
  ↓
SmartTool is swapped for MemeRenderer (reactive, no page reload)
```

### What the user sees during loading

| Phase                   | Display                                                                                         |
| ----------------------- | ----------------------------------------------------------------------------------------------- |
| Before bundle loads     | `SmartTool` with icon from fallback, title "Send Meme", subtitle "writing docs / writing tests" |
| After bundle loads      | `MemeRenderer` with the image rendered inline                                                   |
| If bundle fails to load | `SmartTool` remains — the fallback metadata persists                                            |

The fallback metadata ensures the card is never a bare gray gear with a cryptic tool name. Even if the bundle fails to load entirely (network error, build mismatch, version skew), the tool result is still readable.

---

## Reference

### API types

```ts
// From packages/plugin/src/ui.ts
interface PluginToolRendererProps {
  input: Record<string, unknown>
  metadata: Record<string, unknown>
  tool: string
  title?: string
  output?: string
  status?: string
  raw?: string
  charsReceived?: number
  hideDetails?: boolean
  defaultOpen?: boolean
  forceOpen?: boolean
}

type PluginToolRenderer = Component<PluginToolRendererProps>
```

### Manifest schema for tool renderers

```ts
// From packages/plugin/src/manifest.ts
const ToolRendererDef = z
  .object({
    tool: z.string().min(1),
    exportName: z.string().optional().default("default"),
    priority: z.number().int().min(0).max(100).optional().default(0),
    fallback: z
      .object({
        icon: z.string().optional(),
        title: z.string().optional(),
        subtitleTemplate: z.string().optional(),
      })
      .optional(),
  })
  .strict()
```

### Implementation locations

| Component                    | Path                                                  |
| ---------------------------- | ----------------------------------------------------- |
| Plugin UI types              | `packages/plugin/src/ui.ts`                           |
| Plugin manifest schema       | `packages/plugin/src/manifest.ts`                     |
| Tool result type             | `packages/plugin/src/tool.ts`                         |
| Built-in tool registry       | `packages/ui/src/components/tool-renders.tsx`         |
| Tool registry + lookup chain | `packages/ui/src/components/message-part.tsx`         |
| SmartTool fallback component | `packages/ui/src/components/basic-tool.tsx`           |
| Plugin tool registry         | `packages/app/src/plugin/registries/tool-registry.ts` |
| Plugin lifecycle activation  | `packages/app/src/plugin/lifecycle.ts`                |
| Plugin UI bridge             | `packages/app/src/plugin/bridge.tsx`                  |
| Plugin bundle loader         | `packages/app/src/plugin/loaders.ts`                  |
| Attachment card display      | `packages/ui/src/components/attachment-card.tsx`      |
| Server contribution endpoint | `packages/synergy/src/server/plugin-routes.ts`        |

### Fallback icon names

The `icon` field in `fallback` accepts any [Lucide icon](https://lucide.dev/icons) name. Common choices:

| Tool kind        | Suggested icon            |
| ---------------- | ------------------------- |
| Image generation | `image`, `image-plus`     |
| File reading     | `glasses`, `file-text`    |
| Search           | `search`, `regex`         |
| Web requests     | `globe`, `cable`          |
| Shell commands   | `terminal`                |
| Database/query   | `database`                |
| Network/API      | `plug`, `plug-zap`        |
| Status/health    | `heart-pulse`, `activity` |
| Data/analysis    | `chart-bar`, `pie-chart`  |
| Communication    | `message-square`, `send`  |
| Scheduling       | `clock`, `calendar`       |
| Memory/knowledge | `brain`, `library`        |

---

## Best practices

1. **Always provide fallback metadata.** Even if you build a Tier 2 renderer, the `fallback` fields are the first thing the user sees while the bundle loads. A good fallback makes the tool card immediately recognizable.

2. **Keep the renderer component focused.** A tool renderer should display the tool result clearly, not reimplement the tool's logic. Avoid making API calls or running computations inside the renderer — those belong server-side.

3. **Handle all states.** Your component receives `status` values. Show different UI for pending, generating, completed, and error states. At minimum, render `props.output` when it exists.

4. **Use semantic variables for styling.** The host provides CSS custom properties for colors (`--text-base`, `--surface-brand-base`, etc.). Using these makes your renderer adapt to both light and dark themes automatically.

5. **Export the component as default.** The `exportName` in the manifest defaults to `"default"`. Name your export `default` for the simplest wiring.

6. **Build the UI bundle separately.** The UI bundle targets the browser, not Bun. Use a separate build step with `--target browser` and mark SolidJS as external.

7. **Clean up stale renderers.** The `registerToolRenderer` function returns a disposer function. During plugin deactivation or runtime reload, all disposers are called to remove stale entries.
