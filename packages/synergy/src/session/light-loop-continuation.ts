import { Cortex } from "../cortex"
import { Session } from "./index"
import { ContinuationKernel } from "./continuation-kernel"

export const LightLoopContinuationPolicy: ContinuationKernel.Policy = {
  id: "light_loop",
  priority: 25,
  async handle(gate) {
    const workflow = gate.session.workflow
    if (workflow?.kind !== "lightloop") return undefined
    const stopRequest = workflow.stopRequest
    if (!stopRequest) return continuationProposal(workflow.taskDescription)
    if (stopRequest.reviewSessionID) return undefined

    const task = await prepareReviewer({
      sessionID: gate.sessionID,
      taskDescription: workflow.taskDescription,
      stopRequest,
    })
    await Session.update(gate.sessionID, (draft) => {
      if (draft.workflow?.kind !== "lightloop") return
      const current = draft.workflow.stopRequest
      if (!current || current.requesterMessageID !== stopRequest.requesterMessageID) return
      current.reviewTaskID = task.id
      current.reviewSessionID = task.sessionID
    })
    await Cortex.start(task.id)
    return { kind: "handled" }
  },
}

async function prepareReviewer(input: {
  sessionID: string
  taskDescription: string
  stopRequest: NonNullable<Extract<Session.Info["workflow"], { kind: "lightloop" }>["stopRequest"]>
}) {
  return Cortex.prepare({
    description: `[Review] Review LightLoop: ${input.taskDescription.slice(0, 80)}`,
    prompt: reviewPrompt(input),
    agent: "lightloop-reviewer",
    executionRole: "delegated_subagent",
    category: "general",
    parentSessionID: input.sessionID,
    parentMessageID: input.stopRequest.requesterMessageID,
    reuseInterrupted: true,
    notifyParentOnComplete: false,
    visibility: "hidden",
  })
}

function reviewPrompt(input: {
  sessionID: string
  taskDescription: string
  stopRequest: NonNullable<Extract<Session.Info["workflow"], { kind: "lightloop" }>["stopRequest"]>
}): string {
  return [
    "## Task",
    "Audit this LightLoop stop request.",
    "",
    "## Original task description",
    input.taskDescription,
    "",
    "## Stop request",
    `**Summary:** ${input.stopRequest.summary}`,
    input.stopRequest.completed?.length
      ? `**Completed:**\n${input.stopRequest.completed.map((item) => `- ${item}`).join("\n")}`
      : "",
    input.stopRequest.evidence?.length
      ? `**Evidence:**\n${input.stopRequest.evidence.map((item) => `- ${item}`).join("\n")}`
      : "",
    input.stopRequest.remaining?.length
      ? `**Remaining:**\n${input.stopRequest.remaining.map((item) => `- ${item}`).join("\n")}`
      : "**Remaining:** none claimed",
    "",
    "## Execution session",
    `Session ID: ${input.sessionID}. Use session_read to inspect the execution trajectory.`,
    "",
    "## Instructions",
    "1. Inspect the execution session trajectory and workspace evidence.",
    "2. Verify every explicit requirement and implied deliverable against the task.",
    "3. If all work is complete and verified, call light_loop_approve with the execution session ID and a verdict summary.",
    "4. If any work is missing, partially done, or unverified, call light_loop_reject with concrete remaining instructions.",
  ]
    .filter(Boolean)
    .join("\n")
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
