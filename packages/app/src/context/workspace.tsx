import { createSignal, createMemo, type Component } from "solid-js"
import { createSimpleContext } from "@ericsanchezok/synergy-ui/context"
import { useLayout } from "./layout"
import { useParams } from "@solidjs/router"
import type { IconName } from "@ericsanchezok/synergy-ui/icon"
import { WORKSPACE_DEFAULT_WIDTH } from "./workspace-layout"

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
    const params = useParams()
    const sessionKey = createMemo(() => `${params.dir}${params.id ? "/" + params.id : ""}`)
    const ws = createMemo(() => layout.workspace(sessionKey()))

    const [tools, setTools] = createSignal<WorkspaceTool[]>([])

    const activeTool = createMemo(() => tools().find((t) => t.id === ws().active()))

    return {
      register(tool: WorkspaceTool) {
        setTools((prev) => [...prev.filter((t) => t.id !== tool.id), tool])
      },
      unregister(id: string) {
        setTools((prev) => {
          const next = prev.filter((t) => t.id !== id)
          if (prev.find((t) => t.id === id)?.id === ws().active()) {
            ws().close()
            ws().setActive(null)
          }
          return next
        })
      },
      tools,
      activeTool,
      active: () => ws().active(),
      opened: () => ws().opened() ?? false,
      width: () => ws().width() ?? WORKSPACE_DEFAULT_WIDTH,
      openPanel: () => ws().open(),
      closePanel: () => ws().close(),
      setActive: (id: string | null) => ws().setActive(id),
      setWidth: (w: number) => ws().setWidth(w),
      toggle(toolId: string) {
        if (!ws().opened()) {
          ws().setActive(toolId)
          ws().open()
        } else if (ws().active() === toolId) {
          ws().setActive(null)
          ws().close()
        } else {
          ws().setActive(toolId)
        }
      },
    }
  },
})
