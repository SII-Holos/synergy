import { Show, onMount, onCleanup } from "solid-js"
import { Dynamic } from "solid-js/web"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { IconButton } from "@ericsanchezok/synergy-ui/icon-button"
import { useWorkspace } from "@/context/workspace"
export function WorkspacePanelMobile() {
  const workspace = useWorkspace()
  const tool = () => workspace.activeTool()

  onMount(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && workspace.opened()) {
        workspace.closePanel()
      }
    }
    document.addEventListener("keydown", handler)
    onCleanup(() => document.removeEventListener("keydown", handler))
  })

  return (
    <Show when={workspace.opened()}>
      <div class="fixed inset-0 z-50 flex flex-col bg-background-stronger">
        <div class="flex items-center justify-between px-4 h-11 shrink-0 border-b border-border-weak-base/60">
          <span class="text-14-medium text-text-strong">{tool()?.label ?? ""}</span>
          <IconButton icon="x" variant="ghost" onClick={() => workspace.closePanel()} />
        </div>
        <div class="flex-1 min-h-0 overflow-hidden">
          <Show when={tool()}>
            <Dynamic component={tool()!.component} />
          </Show>
        </div>
      </div>
    </Show>
  )
}
