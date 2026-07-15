import { ContinuationKernel } from "./continuation-kernel"

export const LightLoopContinuationPolicy: ContinuationKernel.Policy = {
  id: "light_loop",
  priority: 25,
  async handle(gate) {
    if (gate.session.workflow?.kind !== "lightloop") return undefined
    if (gate.session.workflow.stopRequest?.reviewSessionID) return undefined
    return continuationProposal(gate.session.workflow.taskDescription)
  },
}

function continuationProposal(taskDescription: string): ContinuationKernel.InboxProposal {
  return {
    kind: "inbox",
    mode: "steer",
    message: {
      role: "user",
      summary: { title: "Continue light loop" },
      origin: { type: "system" },
      parts: [
        {
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
  }
}
