import { For, Show } from "solid-js"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { Tooltip } from "@ericsanchezok/synergy-ui/tooltip"
import { useWorkspace } from "@/context/workspace"
import "./workspace-rail.css"

export function WorkspaceRail() {
  const workspace = useWorkspace()

  return (
    <Show when={workspace.tools().length > 0}>
      <div class="workspace-rail" role="toolbar" aria-label="Workspace tools">
        <For each={workspace.tools()}>
          {(tool) => {
            const isActive = () => workspace.opened() && workspace.active() === tool.id
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
      </div>
    </Show>
  )
}
