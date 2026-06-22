import { Show } from "solid-js"
import { ToolRegistry } from "../../message-part"

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
  "browser_tab",
  "browser_annotate",
] as const

const toolLabels: Record<string, string> = {
  browser_navigate: "\u{1F310} Navigate",
  browser_snapshot: "\u{1F50D} Snapshot",
  browser_screenshot: "\u{1F4F8} Screenshot",
  browser_click: "\u{1F5B1}\u{FE0F} Click",
  browser_type: "\u{2328}\u{FE0F} Type",
  browser_scroll: "\u{2195}\u{FE0F} Scroll",
  browser_wait: "\u{23F3} Wait",
  browser_inspect: "\u{1F50E} Inspect",
  browser_read: "\u{1F4D6} Read",
  browser_console: "\u{1F4CB} Console",
  browser_network: "\u{1F310} Network",
  browser_download: "\u{1F4E5} Download",
  browser_tab: "\u{1F4D1} Tab",
  browser_annotate: "\u{1F4AC} Annotate",
}

function formattedToolName(tool: string): string {
  return toolLabels[tool] ?? tool
}

for (const name of browserToolNames) {
  ToolRegistry.register({
    name,
    render(props) {
      const label = formattedToolName(name)
      return (
        <div class="p-2 text-sm">
          <div class="font-medium text-text-secondary mb-1">{label}</div>
          <Show when={props.output}>
            {(output) => <div class="text-text-primary whitespace-pre-wrap">{output()}</div>}
          </Show>
        </div>
      )
    },
  })
}
