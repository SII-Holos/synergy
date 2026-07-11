import { createEffect } from "solid-js"
import type { Message, ToolPart } from "@ericsanchezok/synergy-sdk"
import { useData } from "@ericsanchezok/synergy-ui/context"
import { useWorkbenchPanels } from "@/context/workbench"
import { applyBrowserViewCommand, shouldAutoShowBrowserTool } from "./browser-view-command"

export function BrowserViewEffects(props: { timeline: () => Message[] }) {
  const workspace = useWorkbenchPanels()
  const data = useData()
  const handled = new Set<string>()

  createEffect(() => {
    for (const message of props.timeline()) {
      for (const part of data.store.part[message.id] ?? []) {
        if (part.type !== "tool") continue
        const tool = part as ToolPart
        if (tool.state.status !== "completed") continue
        if (handled.has(tool.callID)) continue
        const metadata = tool.state.metadata as Record<string, unknown>

        if (tool.tool !== "browser_view") {
          if (!shouldAutoShowBrowserTool(tool.tool, metadata)) continue
          handled.add(tool.callID)
          applyBrowserViewCommand({ workspaceCommand: "show" }, workspace)
          continue
        }

        handled.add(tool.callID)

        applyBrowserViewCommand(metadata, workspace)
      }
    }
  })

  return null
}
