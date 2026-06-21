import { Show, Suspense, onMount, onCleanup, createSignal, createMemo, createEffect } from "solid-js"
import { Dynamic } from "solid-js/web"
import type { Component } from "solid-js"
import { Spinner } from "@ericsanchezok/synergy-ui/spinner"
import { ResizeHandle } from "@ericsanchezok/synergy-ui/resize-handle"
import { useWorkspace } from "@/context/workspace"
import { computeMaxWorkspaceWidth, WORKSPACE_MIN_WIDTH, WORKSPACE_SESSION_MIN_WIDTH } from "@/context/workspace-layout"
import { getWorkspacePanel, loadPluginExport, getPluginContribution } from "@/plugin"
import "./workspace-drawer.css"

/** Wrapper that shows a skeleton/spinner while lazy-loading a plugin panel component. */
function PluginWorkspaceContent(props: { panelId: string }) {
  const [comp, setComp] = createSignal<Component | null>(null)
  const [loading, setLoading] = createSignal(true)

  onMount(() => {
    const entry = getWorkspacePanel(props.panelId)
    if (!entry) {
      setLoading(false)
      return
    }
    if (entry.component) {
      setComp(() => entry.component!)
      setLoading(false)
      return
    }
    if (entry.sandbox) {
      // Sandbox panels rendered via iframe — handled elsewhere
      setLoading(false)
      return
    }
    if (entry.pluginId && entry.exportName) {
      const contrib = getPluginContribution(entry.pluginId)
      if (contrib) {
        loadPluginExport(contrib, entry.exportName)
          .then((c) => {
            setComp(() => c as Component)
            setLoading(false)
          })
          .catch(() => setLoading(false))
        return
      }
    }
    setLoading(false)
  })

  return (
    <Show
      when={!loading()}
      fallback={
        <div class="flex items-center justify-center h-full">
          <Spinner class="size-5" />
        </div>
      }
    >
      <Show
        when={comp()}
        fallback={
          <div class="flex items-center justify-center h-full text-text-weak text-14">Plugin panel unavailable</div>
        }
      >
        {(c) => <Dynamic component={c()} />}
      </Show>
    </Show>
  )
}

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
  const maxWidth = () => computeMaxWorkspaceWidth(window.innerWidth, { sessionMinWidth: WORKSPACE_SESSION_MIN_WIDTH })
  const handleResize = (w: number) => {
    workspace.setWidth(w)
  }

  // Detect whether the active tool is a plugin panel that needs lazy loading
  const isPluginPanel = createMemo(() => {
    const t = tool()
    if (!t) return false
    return !!getWorkspacePanel(t.id)
  })

  return (
    <div
      class="workspace-drawer relative shrink-0 h-full"
      classList={{ "workspace-drawer--closing": !workspace.opened() && closing() }}
      style={{ width: workspace.opened() ? `${workspace.width()}px` : "0px" }}
    >
      <ResizeHandle
        direction="horizontal"
        edge="start"
        size={workspace.width()}
        min={WORKSPACE_MIN_WIDTH}
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
        class="workspace-drawer-panel h-full flex flex-col overflow-hidden border-l border-border-weak-base bg-background-stronger"
        classList={{ "workspace-drawer-panel--open": workspace.opened() }}
        style={{ width: `${workspace.width()}px` }}
        role="complementary"
        aria-label="Session workspace"
      >
        <div class="flex-1 min-h-0 overflow-hidden">
          <Show
            when={tool()}
            fallback={
              <div class="flex items-center justify-center h-full text-text-weak text-14">No tool selected</div>
            }
          >
            <Show
              when={isPluginPanel()}
              fallback={
                <Suspense
                  fallback={
                    <div class="flex items-center justify-center h-full">
                      <Spinner class="size-5" />
                    </div>
                  }
                >
                  <Dynamic component={tool()!.component} />
                </Suspense>
              }
            >
              <PluginWorkspaceContent panelId={tool()!.id} />
            </Show>
          </Show>
        </div>
      </aside>
    </div>
  )
}
