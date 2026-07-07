import { Identifier } from "@/id/id"
import { ContinuationKernel } from "./continuation-kernel"
import { SessionManager } from "./manager"

/**
 * LightLoopContinuationPolicy: when a session with lightLoop.active goes idle
 * after a terminal assistant response, deliver a continuation message prompting
 * the agent to continue working on the task.
 */
export const LightLoopContinuationPolicy: ContinuationKernel.Policy = {
  id: "light_loop",
  priority: 25,
  async handle(gate) {
    const ll = gate.session.lightLoop
    if (!ll?.active) return false
    await deliverContinuation(gate.sessionID, ll.taskDescription)
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
          text: `Task: ${taskDescription}\n\nAssess whether the task is fully complete. If not, continue working. If yes, call loop_stop().`,
          synthetic: true,
        },
      ],
      metadata: { source: "light_loop_continuation" },
    },
  })
}
