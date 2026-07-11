import { For } from "solid-js"
import { IconButton } from "@ericsanchezok/synergy-ui/icon-button"
import { getSemanticIcon, type SemanticIconTokenName } from "@ericsanchezok/synergy-ui/semantic-icon"
import { useBrowser, type DevPanel } from "./browser-store"

interface ToolbarAction {
  id: DevPanel
  label: string
  icon: SemanticIconTokenName
}

const ACTIONS: ToolbarAction[] = [
  { id: "screenshot", label: "Screenshot", icon: "browser.screenshot" },
  { id: "inspect", label: "Inspect", icon: "browser.inspect" },
  { id: "console", label: "Console", icon: "browser.console" },
  { id: "network", label: "Network", icon: "browser.network" },
  { id: "elements", label: "Elements", icon: "browser.elements" },
  { id: "assets", label: "Assets", icon: "browser.assets" },
  { id: "downloads", label: "Downloads", icon: "browser.downloads" },
]

export function DevToolbar() {
  const { send, devPanel, toggleDevPanel, pageId } = useBrowser()

  const handleClick = (action: ToolbarAction) => {
    if (action.label === "Screenshot") {
      send({ type: "requestScreenshot", pageId: pageId() })
    } else {
      toggleDevPanel(action.id)
      if (action.id === "console") send({ type: "requestConsole", pageId: pageId(), maxEntries: 100 })
      if (action.id === "network") send({ type: "requestNetwork", pageId: pageId(), maxEntries: 200 })
      if (action.id === "elements") send({ type: "requestSnapshot", pageId: pageId() })
      if (action.id === "assets") send({ type: "requestAssets", pageId: pageId(), maxEntries: 200 })
    }
  }

  const isActive = (panel: DevPanel) => devPanel() === panel

  return (
    <div class="workbench-panel-surface flex items-center gap-1 border-t border-border-weak-base/60 px-2 py-1">
      <For each={ACTIONS}>
        {(action) => (
          <IconButton
            icon={getSemanticIcon(action.icon)}
            variant={isActive(action.id) && action.label !== "Screenshot" ? "primary" : "ghost"}
            size="normal"
            onClick={() => handleClick(action)}
            title={action.label}
          />
        )}
      </For>
    </div>
  )
}
