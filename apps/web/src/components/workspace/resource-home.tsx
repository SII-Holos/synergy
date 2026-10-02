import { For, Show } from "solid-js"
import { useLingui } from "@lingui/solid"
import { Icon, type IconName } from "@ericsanchezok/synergy-ui/icon"
import { useWorkbenchPanels } from "@/context/workbench"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import type { WorkbenchPanelContentProps } from "@/plugin/registries/workbench-panel-registry"

export function ResourceHome(props: WorkbenchPanelContentProps) {
  const workbench = useWorkbenchPanels()
  const lingui = useLingui()
  const resources = () => workbench.panels("side").filter((panel) => ["notes", "file", "browser"].includes(panel.id))
  return (
    <div class="resource-home">
      <div class="resource-home-content">
        <div class="resource-home-heading">
          <div class="resource-home-icon">
            <Icon name={getSemanticIcon("workspace.newTab")} size="normal" />
          </div>
          <h2>{lingui._({ id: "workspace.home.newTab", message: "New tab" })}</h2>
        </div>
        <Show
          when={resources().length}
          fallback={
            <p>
              {lingui._({ id: "workspace.home.unavailable", message: "No resources are available in this project." })}
            </p>
          }
        >
          <div class="resource-home-grid">
            <For each={resources()}>
              {(panel) => (
                <button
                  type="button"
                  class="resource-home-card"
                  onClick={() => void workbench.openPanel(panel.id, { replaceTab: props.tab.id })}
                >
                  <Icon name={panel.icon as IconName} size="small" />
                  <span>{panel.label}</span>
                </button>
              )}
            </For>
          </div>
        </Show>
      </div>
    </div>
  )
}
