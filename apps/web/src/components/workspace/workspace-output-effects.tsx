import { createEffect } from "solid-js"
import { useParams } from "@solidjs/router"
import { useData } from "@ericsanchezok/synergy-ui/context"
import { useSDK } from "@/context/sdk"
import { useWorkbenchPanels } from "@/context/workbench"
import { workspaceOutputResources } from "./workspace-output-resources"

export function WorkspaceOutputEffects() {
  const workbench = useWorkbenchPanels(),
    data = useData(),
    params = useParams(),
    sdk = useSDK()
  createEffect(() => {
    const sessionID = params.id
    if (!sessionID) return
    for (const message of data.view.messagesFor(sessionID)) {
      for (const resource of workspaceOutputResources({
        message,
        parts: data.view.partsFor(message.id),
        currentSessionID: sessionID,
        scopeID: sdk.scopeID,
      }))
        void workbench.revealOutput(resource)
    }
  })
  return null
}
