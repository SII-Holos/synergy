import { For } from "solid-js"
import { IconButton } from "@ericsanchezok/synergy-ui/icon-button"
import { useBrowser, type DevPanel } from "./browser-store"

interface ToolbarAction {
  id: DevPanel
  label: string
  icon: string
}

const ACTIONS = [
  { id: "screenshot" as DevPanel, label: "Screenshot", icon: "image" },
  { id: "inspect" as DevPanel, label: "Inspect", icon: "scan-eye" },
  { id: "console" as DevPanel, label: "Console", icon: "terminal" },
  { id: "network" as DevPanel, label: "Network", icon: "signal" },
  { id: "elements" as DevPanel, label: "Annotate", icon: "pen" },
]

export function DevToolbar() {
  const { send, devPanel, toggleDevPanel } = useBrowser()

  const handleClick = (action: ToolbarAction) => {
    if (action.label === "Screenshot") {
      send({ type: "requestScreenshot" })
    } else {
      toggleDevPanel(action.id)
    }
  }

  const isActive = (panel: DevPanel) => devPanel() === panel

  return (
    <div class="flex items-center gap-1 px-2 py-1 bg-background-weak border-t border-border-weak-base/60">
      <For each={ACTIONS}>
        {(action) => (
          <IconButton
            icon={action.icon}
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
