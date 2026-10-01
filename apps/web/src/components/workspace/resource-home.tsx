import { For, Show } from "solid-js"
import { useLingui } from "@lingui/solid"
import { Icon, type IconName } from "@ericsanchezok/synergy-ui/icon"
import { useWorkbenchPanels } from "@/context/workbench"
import { isWorkbenchPanelLaunchable } from "@/context/workbench/panel-model"

export function ResourceHome() {
  const workbench = useWorkbenchPanels()
  const lingui = useLingui()
  const recent = () =>
    workbench
      .surface("side")
      .tabs()
      .filter((tab) => tab.panelId !== "resource-home" && workbench.panelForTab(tab))
  return (
    <div class="resource-home">
      <header class="resource-home-toolbar">
        <h2>{lingui._({ id: "workspace.home.title", message: "Workspace" })}</h2>
      </header>
      <div class="resource-home-content">
        <Show when={recent().length}>
          <h3>{lingui._({ id: "workspace.home.continue", message: "Continue viewing" })}</h3>
        </Show>
        <For each={recent()}>
          {(tab) => (
            <button
              type="button"
              class="workbench-surface-launcher-row"
              onClick={() => workbench.activateTab("side", tab.id)}
            >
              <Icon name={workbench.panelForTab(tab)!.icon as IconName} size="small" />
              <span>{workbench.panelTitle(tab)}</span>
            </button>
          )}
        </For>
        <h3>{lingui._({ id: "workspace.home.available", message: "Open a resource" })}</h3>
        <For each={workbench.panels("side").filter(isWorkbenchPanelLaunchable)}>
          {(panel) => (
            <button
              type="button"
              class="workbench-surface-launcher-row"
              onClick={() => void workbench.openPanel(panel.id, { reuseExisting: true })}
            >
              <Icon name={panel.icon as IconName} size="small" />
              <span>{panel.label}</span>
            </button>
          )}
        </For>
      </div>
    </div>
  )
}
