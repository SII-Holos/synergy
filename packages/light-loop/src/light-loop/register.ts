import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { isActiveLightLoopWorkflow } from "../session/light-loop-state"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionAbort } from "@ericsanchezok/synergy-harness/session/abort"
import { ContinuationKernel } from "@ericsanchezok/synergy-harness/session/continuation-kernel"
import type { Info as SessionInfo } from "@ericsanchezok/synergy-harness/session/types"
import { WorkflowPromptRegistry } from "@ericsanchezok/synergy-harness/session/workflow-prompt-registry"
import { ToolRegistry } from "@ericsanchezok/synergy-harness/tool/registry"
import { LightLoopContinuationPolicy } from "./continuation"
import { LightLoopRuntime } from "./runtime"
import { LoopStopTool } from "./tools/loop-stop"

/**
 * Light Loop domain registration (H1 continuation provider + H2 prompt
 * contribution with lifecycle hooks + domain tools). Loaded through
 * src/registration.ts.
 */
const runtimeState = RuntimeContext.state(() => ({
  registered: false,
}))

function lightLoopContextBlock(instructions: string): string {
  return `<light-loop-context>
Goal: ${instructions}
Continue until the complete goal is delivered and verified. Keep this original goal and subsequent user corrections in view across subtasks, compaction and resumption; do not silently drop requirements. Use detail and checks proportional to the task. Reuse valid evidence, repeating checks when changes invalidate it.
Before completion, compare the full goal against actual results and remaining gaps. If required work or verification remains, continue. Otherwise call loop_stop({summary}) with results and concrete evidence. This completes the Light Loop directly; do not claim unverified work is done.
</light-loop-context>`
}

export function registerLightLoopDomain(): void {
  const instanceState = runtimeState()

  if (instanceState.registered) return
  instanceState.registered = true

  ContinuationKernel.registerProvider("lightloop", () => [LightLoopContinuationPolicy])

  WorkflowPromptRegistry.register({
    kind: "lightloop",
    acceptsUserRequest: (session) => isActiveLightLoopWorkflow(session.workflow),
    isActive: async (session) => isActiveLightLoopWorkflow(session.workflow),
    controlSources: ["light_loop_continuation"],
    buildSystem(session: SessionInfo) {
      const workflow = session.workflow
      if (workflow?.kind !== "lightloop") return []
      return [lightLoopContextBlock(workflow.instructions)]
    },
    async onLoopError(sessionID: string, error: unknown) {
      await LightLoopRuntime.failActiveLoop(sessionID, error)
    },
    async cancel(sessionID: string) {
      const session = await Session.get(sessionID)
      if (session.workflow?.kind !== "lightloop") return session
      // Light Loop withdrawing its own work is not the user asking the session
      // to hold still, so no pause is latched.
      await SessionAbort.abort(sessionID, { internalCancel: true })
      // Use the single terminal path so the authoritative terminal record is
      // persisted and the interactive workflow is cleared consistently with
      // completion, deadline, and failure.
      await LightLoopRuntime.setTerminalStatus(sessionID, "cancelled")
      return Session.get(sessionID)
    },
    reattachPluginTimers() {
      return LightLoopRuntime.reattachPluginTimers()
    },
  })

  ToolRegistry.registerToolProvider("lightloop", () => [LoopStopTool])
}
