import { Show, Suspense, onMount, onCleanup, createSignal, createMemo, createEffect } from "solid-js"
import { Dynamic } from "solid-js/web"
import { Spinner } from "@ericsanchezok/synergy-ui/spinner"
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
        <div class="flex-1 min-h-0 overflow-hidden">
          <Show
            when={tool()}
            fallback={
              <div class="flex items-center justify-center h-full text-text-weak text-14">No tool selected</div>
            }
          >
            <Suspense
              fallback={
                <div class="flex items-center justify-center h-full">
                  <Spinner class="size-5" />
                </div>
              }
            >
              <Dynamic component={tool()!.component} />
            </Suspense>
          </Show>
        </div>
      </aside>
    </>
  )
}
