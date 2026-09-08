import type { PluginLightLoopAdapter } from "@ericsanchezok/synergy-plugin-host/plugin/host-services"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionWorkflowService } from "../session/workflow"
import { LightLoopRuntime } from "./runtime"
import { LightLoopTerminalStore } from "./terminal-hook"

export const lightLoopPluginAdapter: PluginLightLoopAdapter = {
  async start(sessionID, input) {
    await SessionWorkflowService.startLightloop(sessionID, input.instructions)
    await Session.update(sessionID, (draft) => {
      if (draft.workflow?.kind !== "lightloop") return
      draft.workflow = { ...draft.workflow, ...input, status: "running" }
    })
  },
  async clear(sessionID) {
    await Session.update(sessionID, (draft) => {
      draft.workflow = undefined
      draft.time.archived = Date.now()
    })
  },
  getActive(session) {
    const workflow = session.workflow?.kind === "lightloop" ? session.workflow : undefined
    if (!workflow) return undefined
    return {
      instructions: workflow.instructions,
      pluginOwner: workflow.pluginOwner,
      reviewSessionID: workflow.stopRequest?.reviewSessionID,
    }
  },
  scheduleDeadline(sessionID: string, deadlineAt: number) {
    LightLoopRuntime.scheduleDeadline(sessionID, deadlineAt)
  },
  setTerminalStatus(
    sessionID: string,
    status: Parameters<typeof LightLoopRuntime.setTerminalStatus>[1],
    error?: string,
  ) {
    return LightLoopRuntime.setTerminalStatus(sessionID, status, error)
  },
  getTerminal(session: Parameters<typeof LightLoopTerminalStore.get>[0]) {
    return LightLoopTerminalStore.get(session)
  },
}
