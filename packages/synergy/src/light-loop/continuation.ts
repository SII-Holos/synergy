import { Cortex, CortexTypes } from "../cortex"
import { Session } from "../session"
import { ContinuationKernel } from "../session/continuation-kernel"
import { isActiveLightLoopWorkflow } from "../session/light-loop-state"
import { LightLoopRuntime } from "./runtime"
import { ReviewToolRecovery } from "../session/review-tool-recovery"
import { SessionInbox } from "../session/inbox"

const LIGHT_LOOP_APPROVE_TOOL = "light_loop_approve"
const LIGHT_LOOP_REJECT_TOOL = "light_loop_reject"

export const LightLoopContinuationPolicy: ContinuationKernel.Policy = {
  id: "light_loop",
  priority: 25,
  revisionKey(gate) {
    const workflow = gate.session.workflow
    if (!isActiveLightLoopWorkflow(workflow)) return gate.terminalMessageID
    return [
      gate.terminalMessageID,
      workflow.status ?? "running",
      workflow.stopRequest?.requesterMessageID ?? "no-stop-request",
      workflow.stopRequest?.reviewTaskID ?? "no-review-task",
      workflow.stopRequest?.reviewToolRecoveryAttempts ?? 0,
    ].join("|")
  },
  async handle(gate) {
    const workflow = gate.session.workflow
    if (!isActiveLightLoopWorkflow(workflow)) return undefined
    const stopRequest = workflow.stopRequest
    if (!stopRequest) return continuationProposal(workflow.instructions)
    if (stopRequest.reviewSessionID) {
      return recoverTerminalReviewer({
        sessionID: gate.sessionID,
        instructions: workflow.instructions,
        reviewAgent: workflow.reviewAgent,
        pluginOwned: workflow.pluginOwner !== undefined,
        stopRequest,
      })
    }

    const task = await prepareReviewer({
      sessionID: gate.sessionID,
      instructions: workflow.instructions,
      reviewAgent: workflow.reviewAgent,
      reviewTools: workflow.reviewTools,
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

async function recoverTerminalReviewer(input: {
  sessionID: string
  instructions: string
  reviewAgent?: string
  pluginOwned: boolean
  stopRequest: NonNullable<Extract<Session.Info["workflow"], { kind: "lightloop" }>["stopRequest"]>
}): Promise<ContinuationKernel.PolicyResult> {
  const reviewSessionID = input.stopRequest.reviewSessionID
  const reviewTaskID = input.stopRequest.reviewTaskID
  if (!reviewSessionID || !reviewTaskID) return undefined
  const reviewer = await Session.get(reviewSessionID).catch(() => undefined)

  if (
    !reviewer?.cortex ||
    reviewer.cortex.taskID !== reviewTaskID ||
    reviewer.cortex.status === "interrupted" ||
    !CortexTypes.isTerminalStatus(reviewer.cortex.status)
  ) {
    return undefined
  }
  if (reviewer.cortex.launchFailure === true) {
    const error = ReviewToolRecovery.launchError(reviewer.cortex.error)
    if (!input.pluginOwned) {
      await deliverExhaustionNotice(input.sessionID, input.stopRequest.requesterMessageID, error)
    }
    await LightLoopRuntime.setTerminalStatus(input.sessionID, "failed", error)
    return { kind: "handled" }
  }

  const attempts = input.stopRequest.reviewToolRecoveryAttempts ?? 0
  if (attempts >= ReviewToolRecovery.MAX_ATTEMPTS) {
    const error = ReviewToolRecovery.exhaustedError(attempts)
    if (!input.pluginOwned) {
      await deliverExhaustionNotice(input.sessionID, input.stopRequest.requesterMessageID, error)
    }
    await LightLoopRuntime.setTerminalStatus(input.sessionID, "failed", error)
    return { kind: "handled" }
  }

  const nextAttempt = attempts + 1
  const task = await Cortex.prepare({
    description: `[Review Recovery ${nextAttempt}] Review LightLoop: ${input.instructions.slice(0, 80)}`,
    prompt: ReviewToolRecovery.prompt({
      executionSessionID: input.sessionID,
      approveTool: LIGHT_LOOP_APPROVE_TOOL,
      rejectTool: LIGHT_LOOP_REJECT_TOOL,
      attempt: nextAttempt,
    }),
    agent: input.reviewAgent ?? "lightloop-reviewer",
    executionRole: "delegated_subagent",
    category: "general",
    parentSessionID: input.sessionID,
    parentMessageID: input.stopRequest.requesterMessageID,
    sessionID: reviewSessionID,
    tools: ReviewToolRecovery.tools(LIGHT_LOOP_APPROVE_TOOL, LIGHT_LOOP_REJECT_TOOL),
    reuseInterrupted: true,
    notifyParentOnComplete: false,
    visibility: "visible",
  })
  let bound = false
  await Session.update(input.sessionID, (draft) => {
    if (draft.workflow?.kind !== "lightloop") return
    const current = draft.workflow.stopRequest
    if (
      !current ||
      current.requesterMessageID !== input.stopRequest.requesterMessageID ||
      current.reviewSessionID !== reviewSessionID ||
      current.reviewTaskID !== reviewTaskID
    ) {
      return
    }
    current.reviewTaskID = task.id
    current.reviewToolRecoveryAttempts = nextAttempt
    bound = true
  })
  if (!bound) {
    await Cortex.cancel(task.id).catch(() => undefined)
    return { kind: "handled" }
  }
  await Cortex.start(task.id)
  return { kind: "handled" }
}

async function deliverExhaustionNotice(
  executionSessionID: string,
  requesterMessageID: string,
  error: string,
): Promise<void> {
  await SessionInbox.deliverUnique({
    sessionID: executionSessionID,
    deliveryKey: `lightloop-review-exhausted:${requesterMessageID}`,
    mode: "context",
    message: {
      role: "assistant",
      agent: "lightloop-reviewer",
      visible: true,
      metadata: { source: "light_loop_exhaustion" },
      parts: [
        {
          type: "text",
          text: `[Light Loop Review Failed]\n${error}\nThe workflow stopped without an approval or rejection. Restart the Light Loop manually if more work is required.`,
        },
      ],
    },
  })
}

async function prepareReviewer(input: {
  sessionID: string
  instructions: string
  reviewAgent?: string
  reviewTools?: Record<string, boolean>
  stopRequest: NonNullable<Extract<Session.Info["workflow"], { kind: "lightloop" }>["stopRequest"]>
}) {
  return Cortex.prepare({
    description: `[Review] Review LightLoop: ${input.instructions.slice(0, 80)}`,
    prompt: reviewPrompt(input),
    agent: input.reviewAgent ?? "lightloop-reviewer",
    executionRole: "delegated_subagent",
    category: "general",
    parentSessionID: input.sessionID,
    parentMessageID: input.stopRequest.requesterMessageID,
    tools: input.reviewTools,
    reuseInterrupted: true,
    notifyParentOnComplete: false,
    visibility: "visible",
  })
}

function reviewPrompt(input: {
  sessionID: string
  instructions: string
  stopRequest: NonNullable<Extract<Session.Info["workflow"], { kind: "lightloop" }>["stopRequest"]>
}): string {
  return [
    "## Task",
    "Audit this LightLoop stop request.",
    "",
    "## Original task description",
    input.instructions,
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

function continuationProposal(instructions: string): ContinuationKernel.InboxProposal {
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
          text: `Task: ${instructions}

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
