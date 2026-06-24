import { For, createMemo } from "solid-js"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { Tooltip } from "@ericsanchezok/synergy-ui/tooltip"
import { useWorkspace } from "@/context/workspace"
import { useLayout } from "@/context/layout"
import { computeWorkspaceRailRight } from "@/context/workspace-layout"
import "./workspace-rail.css"

export function WorkspaceRail() {
  const workspace = useWorkspace()
  const layout = useLayout()

  return (
    <div
      class="workspace-rail"
      classList={{
        "workspace-rail--open": workspace.opened(),
      }}
      role="toolbar"
      aria-label="Session tools"
      style={{
        right: workspace.opened() ? `${computeWorkspaceRailRight(workspace.width(), window.innerWidth)}px` : undefined,
      }}
    >
      <For each={workspace.tools()}>
        {(tool) => {
          const isActive = createMemo(() => workspace.opened() && workspace.active() === tool.id)
          return (
            <Tooltip value={tool.label} placement="left">
              <button
                type="button"
                class="workspace-rail-btn"
                classList={{ "workspace-rail-btn--active": isActive() }}
                aria-label={tool.label}
                aria-pressed={isActive()}
                onClick={() => workspace.toggle(tool.id)}
              >
                <Icon name={tool.icon} size="normal" />
              </button>
            </Tooltip>
          )
        }}
      </For>
      <Tooltip placement="left" value={layout.terminal.opened() ? "Hide terminal" : "Open terminal"}>
        <button
          type="button"
          class="workspace-rail-btn"
          classList={{ "workspace-rail-btn--active": layout.terminal.opened() }}
          aria-label={layout.terminal.opened() ? "Hide terminal" : "Open terminal"}
          aria-pressed={layout.terminal.opened()}
          onClick={() => layout.terminal.toggle()}
        >
          <Icon name={layout.terminal.opened() ? "panel-bottom" : "terminal"} size="normal" />
        </button>
      </Tooltip>
    </div>
  )
}
