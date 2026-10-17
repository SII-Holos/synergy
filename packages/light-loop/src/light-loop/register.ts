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
Deliver and verify the complete goal and subsequent user corrections across subtasks, compaction and resumption. Use proportional checks and reuse valid evidence unless changes invalidate it.
Before completion, compare all requirements with actual results. Continue if any required work or verification remains; otherwise call loop_stop({summary}) with concise results, key checks and evidence references. This completes the Light Loop directly.
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
