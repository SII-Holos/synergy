import { Session } from "../session"
import { SessionAbort } from "../session/abort"
import { ContinuationKernel } from "../session/continuation-kernel"
import type { Info as SessionInfo } from "../session/types"
import { WorkflowPromptRegistry } from "../session/workflow-prompt-registry"
import { ToolRegistry } from "../tool/registry"
import { LightLoopContinuationPolicy } from "./continuation"
import { LightLoopRuntime } from "./runtime"
import { LoopStopTool } from "./tools/loop-stop"
import { LightLoopApproveTool } from "./tools/light-loop-approve"
import { LightLoopRejectTool } from "./tools/light-loop-reject"

/**
 * Light Loop domain registration (H1 continuation provider + H2 prompt
 * contribution with lifecycle hooks + domain tools). Loaded through
 * src/product-registration.ts.
 */
let registered = false

function lightLoopContextBlock(instructions: string): string {
  return `<light-loop-context>
You are running in the Light Loop workflow. The user has set a task that you must complete fully before stopping.

Task: ${instructions}

Autonomously advance the task until it is complete. Before calling loop_stop(), carefully assess whether every aspect of the task has been addressed:
- Have you produced all requested deliverables, artifacts, or changes?
- Have you verified correctness with appropriate evidence (tests, manual checks, tool output)?
- Are there any remaining gaps, edge cases, or follow-up work implied by the task?

If the task is NOT fully complete, continue working now.
If the task IS complete and verified, call loop_stop() to request a completion review.
Do not stop early, do not pretend the task is complete, and do not hide missing verification from the user.
loop_stop() does not end the Light Loop directly — a reviewer will audit your work first.
</light-loop-context>`
}

function wrapperText(agentName: string, query: string): string {
  const who =
    agentName === "synergy"
      ? "You are synergy in the Light Loop workflow."
      : agentName === "synergy-max"
        ? "You are synergy-max in the Light Loop workflow."
        : "You are in the Light Loop workflow."
  const iterating =
    agentName === "synergy" || agentName === "synergy-max"
      ? "Complete the work thoroughly. Keep working and iterating until the task is fully done, then call loop_stop() to request a completion review."
      : "Complete the work thoroughly. Keep working until the task is fully done, then call loop_stop() to request a completion review."
  return ["<lightloop-user-request>", who, iterating, "", "User request:", query, "</lightloop-user-request>"].join(
    "\n",
  )
}

export function registerLightLoopDomain(): void {
  if (registered) return
  registered = true

  ContinuationKernel.registerProvider("lightloop", () => [LightLoopContinuationPolicy])

  WorkflowPromptRegistry.register({
    kind: "lightloop",
    controlSources: ["light_loop_continuation", "light_loop_approved", "light_loop_rejected"],
    buildSystem(session: SessionInfo) {
      const workflow = session.workflow
      if (workflow?.kind !== "lightloop") return []
      return [lightLoopContextBlock(workflow.instructions)]
    },
    projectUserMessage(query: string, agentName: string) {
      return wrapperText(agentName, query.trim() || "(empty request)")
    },
    async onLoopError(sessionID: string, error: unknown) {
      await LightLoopRuntime.failActiveLoop(sessionID, error)
    },
    async cancel(sessionID: string) {
      const session = await Session.get(sessionID)
      if (session.workflow?.kind !== "lightloop") return session
      await SessionAbort.abort(sessionID)
      // Use the single terminal path so the authoritative terminal record is
      // persisted and the interactive workflow is cleared consistently with
      // approval, exhaustion, deadline, and failure.
      await LightLoopRuntime.setTerminalStatus(sessionID, "cancelled")
      return Session.get(sessionID)
    },
    reattachPluginTimers() {
      return LightLoopRuntime.reattachPluginTimers()
    },
  })

  ToolRegistry.registerToolProvider("lightloop", () => [LoopStopTool, LightLoopApproveTool, LightLoopRejectTool])
}
