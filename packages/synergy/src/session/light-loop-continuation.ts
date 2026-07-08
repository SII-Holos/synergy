import { Identifier } from "@/id/id"
import { ContinuationKernel } from "./continuation-kernel"
import { SessionManager } from "./manager"

/**
 * LightLoopContinuationPolicy: when a Light Loop workflow session goes idle
 * after a terminal assistant response, deliver a continuation message prompting
 * the agent to continue working on the task.
 */
export const LightLoopContinuationPolicy: ContinuationKernel.Policy = {
  id: "light_loop",
  priority: 25,
  async handle(gate) {
    if (gate.session.workflow?.kind !== "lightloop") return false
    // Don't deliver generic continuation while a review is pending
    if (gate.session.workflow.stopRequest?.reviewSessionID) return false
    await deliverContinuation(gate.sessionID, gate.session.workflow.taskDescription)
    return true
  },
}

async function deliverContinuation(sessionID: string, taskDescription: string): Promise<void> {
  await SessionManager.deliver({
    target: sessionID,
    mail: {
      type: "user",
      summary: { title: "Continue light loop" },
      parts: [
        {
          id: Identifier.ascending("part"),
          sessionID,
          messageID: "",
          type: "text",
          text: `Task: ${taskDescription}

Review the task against the current work:
- Are all requested deliverables complete?
- Is the result verified with appropriate evidence?
- Are there unresolved errors, missing edge cases, or implied follow-up steps?

If anything remains, continue working now. If the task is complete and verified, call loop_stop() to request a completion review. Do not claim completion without evidence.`,
          origin: "system",
        },
      ],
      metadata: { source: "light_loop_continuation" },
    },
  })
}
