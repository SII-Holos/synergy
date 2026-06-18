import { createSignal, createMemo, type Component } from "solid-js"
import { createSimpleContext } from "@ericsanchezok/synergy-ui/context"
import { useLayout } from "./layout"
import { useParams } from "@solidjs/router"
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
      width: () => ws().width() ?? 400,
      openPanel: () => {
        console.log("[Workspace] openPanel called, sessionKey:", sessionKey())
        ws().open()
      },
      closePanel: () => ws().close(),
      setActive: (id: string | null) => {
        console.log("[Workspace] setActive:", id, "sessionKey:", sessionKey())
        ws().setActive(id)
      },
      setWidth: (w: number) => ws().setWidth(w),
    }
  },
})
