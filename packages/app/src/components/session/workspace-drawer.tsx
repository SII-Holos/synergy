import { Show, onMount, onCleanup, createSignal, createMemo, createEffect } from "solid-js"
import { Dynamic } from "solid-js/web"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { IconButton } from "@ericsanchezok/synergy-ui/icon-button"
import { ResizeHandle } from "@ericsanchezok/synergy-ui/resize-handle"
import { useWorkspace } from "@/context/workspace"
import "./workspace-drawer.css"

export function WorkspaceDrawer() {
  const workspace = useWorkspace()
  const tool = createMemo(() => workspace.activeTool())

  // Track whether we are in closing animation to keep DOM alive
  const [closing, setClosing] = createSignal(false)
  let drawerEl: HTMLDivElement | undefined

  onMount(() => {
    // Escape key
    const keyHandler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && workspace.opened()) {
        setClosing(true)
        workspace.closePanel()
      }
    }
    document.addEventListener("keydown", keyHandler)

    // Transition end cleanup
    const el = drawerEl
    if (el) {
      const transitionHandler = () => {
        if (!workspace.opened()) {
          setClosing(false)
        }
      }
      el.addEventListener("transitionend", transitionHandler)
      onCleanup(() => el.removeEventListener("transitionend", transitionHandler))
    }

    onCleanup(() => document.removeEventListener("keydown", keyHandler))
  })

  // Reset closing state when the drawer re-opens
  createEffect(() => {
    if (workspace.opened()) setClosing(false)
  })

  // Resize
  const maxWidth = () => Math.min(900, window.innerWidth * 0.45)
  const handleResize = (w: number) => {
    workspace.setWidth(Math.max(300, Math.min(w, maxWidth())))
  }

  return (
    <>
      <ResizeHandle
        direction="horizontal"
        size={workspace.width()}
        min={300}
        max={maxWidth()}
        onResize={handleResize}
        collapseThreshold={200}
        onCollapse={() => {
          setClosing(true)
          workspace.closePanel()
        }}
      />
      <aside
        ref={drawerEl}
        class="shrink-0 h-full flex flex-col overflow-hidden border-l border-border-weak-base bg-background-stronger"
        classList={{
          "workspace-drawer": true,
          "workspace-drawer--closing": !workspace.opened() && closing(),
        }}
        role="complementary"
        aria-label="Session workspace"
        style={{
          width: workspace.opened() ? `${workspace.width()}px` : "0px",
        }}
      >
        <header class="shrink-0 flex items-center justify-between px-4 h-11 border-b border-border-weak-base">
          <div class="flex items-center gap-2 min-w-0">
            <Show when={tool()}>
              <Icon name={tool()!.icon} size="normal" class="text-icon-weak shrink-0" />
              <span class="text-14-medium text-text-strong truncate">{tool()?.label}</span>
            </Show>
          </div>
          <IconButton
            icon="x"
            variant="ghost"
            onClick={() => {
              setClosing(true)
              workspace.closePanel()
            }}
          />
        </header>
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
      </aside>
    </>
  )
}
