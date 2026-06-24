import { Show } from "solid-js"
import { ToolRegistry } from "../../message-part"
import { BasicTool } from "../../basic-tool"
import { ToolTextOutput } from "../../tool-output-text"

const browserToolNames = [
  "browser_navigate",
  "browser_snapshot",
  "browser_screenshot",
  "browser_click",
  "browser_type",
  "browser_scroll",
  "browser_wait",
  "browser_inspect",
  "browser_read",
  "browser_console",
  "browser_network",
  "browser_download",
  "browser_downloads",
  "browser_tab",
  "browser_annotate",
  "browser_action",
  "browser_clipboard",
  "browser_eval",
  "browser_list",
  "browser_assets",
  "browser_view",
  "browser_navigation",
  "browser_viewport",
] as const

const toolConfig: Record<string, { icon: string; title: string }> = {
  browser_navigate: { icon: "globe", title: "Navigate" },
  browser_snapshot: { icon: "binoculars", title: "Snapshot" },
  browser_screenshot: { icon: "image", title: "Screenshot" },
  browser_click: { icon: "mouse-pointer-2", title: "Click" },
  browser_type: { icon: "text-select", title: "Type" },
  browser_scroll: { icon: "arrow-down", title: "Scroll" },
  browser_wait: { icon: "hourglass", title: "Wait" },
  browser_inspect: { icon: "scan-eye", title: "Inspect" },
  browser_read: { icon: "glasses", title: "Read" },
  browser_console: { icon: "file-terminal", title: "Console" },
  browser_network: { icon: "cable", title: "Network" },
  browser_download: { icon: "download", title: "Download" },
  browser_downloads: { icon: "download", title: "Downloads" },
  browser_tab: { icon: "panel-right", title: "Tab" },
  browser_annotate: { icon: "square-pen", title: "Annotate" },
  browser_action: { icon: "mouse-pointer-2", title: "Action" },
  browser_clipboard: { icon: "copy", title: "Clipboard" },
  browser_eval: { icon: "code", title: "Eval" },
  browser_list: { icon: "list", title: "Browser Sessions" },
  browser_assets: { icon: "package", title: "Assets" },
  browser_view: { icon: "panel-right", title: "Browser View" },
  browser_navigation: { icon: "repeat", title: "Navigation" },
  browser_viewport: { icon: "maximize", title: "Viewport" },
}

function formattedToolName(tool: string): string {
  return toolConfig[tool]?.title ?? tool
}

function iconName(tool: string): string {
  return toolConfig[tool]?.icon ?? "globe"
}

function subtitle(input: Record<string, any>, metadata: Record<string, any> | undefined): string | undefined {
  return metadata?.url ?? input.url ?? metadata?.tabId ?? input.tabId ?? input.action ?? input.type
}

function tags(metadata: Record<string, any> | undefined) {
  const values = [
    metadata?.entryCount != null ? `${metadata.entryCount} console` : undefined,
    metadata?.requestCount != null ? `${metadata.requestCount} requests` : undefined,
    metadata?.assetCount != null ? `${metadata.assetCount} assets` : undefined,
    metadata?.elementsCount != null ? `${metadata.elementsCount} elements` : undefined,
    metadata?.captureKind,
  ].filter(Boolean) as string[]
  return values.map((label) => ({ label }))
}

for (const name of browserToolNames) {
  ToolRegistry.register({
    name,
    render(props) {
      const label = formattedToolName(name)
      return (
        <BasicTool
          {...props}
          trigger={{
            icon: iconName(name),
            title: label,
            subtitle: subtitle(props.input, props.metadata),
            tags: tags(props.metadata),
          }}
        >
          <Show when={props.output}>
            {(output) => (
              <div data-component="tool-output" data-scrollable>
                <ToolTextOutput text={output()} />
              </div>
            )}
          </Show>
        </BasicTool>
      )
    },
  })
}
