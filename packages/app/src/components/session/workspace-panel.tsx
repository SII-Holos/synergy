import { Show, createMemo, onMount, onCleanup } from "solid-js"
import { Dynamic } from "solid-js/web"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { IconButton } from "@ericsanchezok/synergy-ui/icon-button"
import { ResizeHandle } from "@ericsanchezok/synergy-ui/resize-handle"
import { useWorkspace } from "@/context/workspace"
import { useLayout } from "@/context/layout"

export function WorkspacePanel() {
  const workspace = useWorkspace()
  const layout = useLayout()
  const isDesktop = () => layout.isDesktop()

  const tool = () => workspace.activeTool()

  // Escape key closes the panel
  onMount(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && workspace.opened()) {
        workspace.closePanel()
      }
    }
    document.addEventListener("keydown", handler)
    onCleanup(() => document.removeEventListener("keydown", handler))
  })

  const panelWidth = () => workspace.width()
  const maxWidth = () => Math.min(900, window.innerWidth * 0.45)

  const handleResize = (w: number) => {
    workspace.setWidth(Math.max(300, Math.min(w, maxWidth())))
  }

  // Desktop: side panel with resize handle
  return (
    <Show when={isDesktop()}>
      <ResizeHandle
        direction="horizontal"
        size={panelWidth()}
        min={300}
        max={maxWidth()}
        onResize={handleResize}
        collapseThreshold={200}
        onCollapse={() => workspace.closePanel()}
      />
      <div
        style={{ width: `${panelWidth()}px` }}
        class="shrink-0 h-full flex flex-col border-l border-border-weak-base bg-background-stronger/60"
      >
        <div class="shrink-0 flex items-center justify-between px-4 h-11 border-b border-border-weak-base">
          <div class="flex items-center gap-2">
            <Show when={tool()}>
              <Icon name="notebook-pen" size="normal" class="text-icon-weak" />
              <span class="text-14-medium text-text-strong">{tool()?.label}</span>
            </Show>
          </div>
          <IconButton icon="x" variant="ghost" onClick={() => workspace.closePanel()} />
        </div>
        <div class="flex-1 min-h-0 overflow-hidden">
          <Show
            when={tool()}
            fallback={
              <div class="flex items-center justify-center h-full text-text-weak text-14">No tool selected</div>
            }
          >
            <Dynamic component={tool()!.component} />
          </Show>
        </div>
      </div>
    </Show>
  )
}

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
