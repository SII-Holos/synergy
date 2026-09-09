import { createEffect } from "solid-js"
import type { Message, ToolPart } from "@ericsanchezok/synergy-sdk"
import { useData } from "@ericsanchezok/synergy-ui/context"
import { useWorkbenchPanels } from "@/context/workbench"
import { applyBrowserViewCommand, shouldAutoShowBrowserTool } from "./browser-view-command"

export function BrowserViewEffects(props: { timeline: () => Message[] }) {
  const workspace = useWorkbenchPanels()
  const data = useData()

  let handledCallIDs = new Set<string>()

  createEffect(() => {
    // Collect the callIDs currently present in the timeline so `handled` stays
    // bounded to the visible window: callIDs that were trimmed away (turnStart
    // advance, session switch) are released instead of accumulating forever.
    const callIDs: string[] = []
    for (const message of props.timeline()) {
      for (const part of data.view.partsFor(message.id)) {
        if (part.type !== "tool") continue
        const tool = part as ToolPart
        if (tool.state.status === "completed") callIDs.push(tool.callID)
      }
    }
    const nextHandled = new Set<string>()
    for (const id of callIDs) {
      if (handledCallIDs.has(id)) nextHandled.add(id)
    }
    handledCallIDs = nextHandled

    for (const message of props.timeline()) {
      for (const part of data.view.partsFor(message.id)) {
        if (part.type !== "tool") continue
        const tool = part as ToolPart
        if (tool.state.status !== "completed") continue
        if (handledCallIDs.has(tool.callID)) continue
        const metadata = tool.state.metadata as Record<string, unknown>

        if (tool.tool !== "browser_view") {
          if (!shouldAutoShowBrowserTool(tool.tool, metadata)) continue
          handledCallIDs.add(tool.callID)
          applyBrowserViewCommand({ workspaceCommand: "show" }, workspace)
          continue
        }

        handledCallIDs.add(tool.callID)

        applyBrowserViewCommand(metadata, workspace)
      }
    }
  })

  return null
}
