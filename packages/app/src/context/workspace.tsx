import { createSignal, createMemo, createEffect, onMount, type Accessor, type Component, onCleanup } from "solid-js"
import { createSimpleContext } from "@ericsanchezok/synergy-ui/context"
import { useLayout } from "./layout"
import { usePanel } from "./panel"
import { useParams } from "@solidjs/router"
import { batch } from "solid-js"
import type { IconName } from "@ericsanchezok/synergy-ui/icon"

export interface WorkspaceTool {
  id: string
  label: string
  icon: IconName
  component: Component
}

export const { use: useWorkspace, provider: WorkspaceProvider } = createSimpleContext({
  name: "Workspace",
  gate: false,
  init: () => {
    const layout = useLayout()
    const panel = usePanel()
    const params = useParams()
    const sessionKey = createMemo(() => `${params.dir}${params.id ? "/" + params.id : ""}`)
    const ws = () => layout.workspace(sessionKey())

    const [tools, setTools] = createSignal<WorkspaceTool[]>([])

    const activeTool = createMemo(() => tools().find((t) => t.id === ws().active()))

    // Intercept global panel "note" toggle → open workspace instead
    onMount(() => {
      createEffect(() => {
        const id = panel.active()
        if (id === "note" && params.id) {
          batch(() => {
            panel.close()
            ws().open()
            ws().setActive("notes")
          })
        }
      })
    })

    return {
      register(tool: WorkspaceTool) {
        setTools((prev) => [...prev.filter((t) => t.id !== tool.id), tool])
      },
      unregister(id: string) {
        setTools((prev) => prev.filter((t) => t.id !== id))
      },
      tools,
      activeTool,
      active: () => ws().active(),
      opened: () => ws().opened() ?? false,
      width: () => ws().width() ?? 400,
      openPanel: () => ws().open(),
      closePanel: () => ws().close(),
      togglePanel: () => ws().toggle(),
      setActive: (id: string | null) => ws().setActive(id),
      setWidth: (w: number) => ws().setWidth(w),
    }
  },
})
