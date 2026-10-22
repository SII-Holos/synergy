import { LoopEvent } from "./event"
import { Bus } from "@ericsanchezok/synergy-harness/bus"
import { Cortex, CortexTypes } from "@ericsanchezok/synergy-harness/cortex"
import { SessionManager } from "@ericsanchezok/synergy-harness/session/manager"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { BlueprintLoopStore, type Info as BlueprintLoopInfo } from "./index"
import { ContinuationKernel } from "@ericsanchezok/synergy-harness/session/continuation-kernel"
import { ReviewToolRecovery } from "@ericsanchezok/synergy-harness/session/review-tool-recovery"
import { BlueprintLoopSources } from "./source"
import { BLUEPRINT_PAUSE_GUIDANCE } from "./prompt"

const BLUEPRINT_APPROVE_TOOL = "blueprint_loop_approve"
const BLUEPRINT_REJECT_TOOL = "blueprint_loop_reject"
export const BlueprintContinuationPolicy: ContinuationKernel.Policy = {
  id: "blueprint_loop",
  priority: 100,
  async revisionKey(gate) {
    const loopID = gate.session.blueprint?.loopID
    if (!loopID) return gate.terminalMessageID
    const loop = await BlueprintLoopStore.get(gate.scopeID, loopID).catch(() => undefined)
    if (!loop) return gate.terminalMessageID
    return [
      gate.terminalMessageID,
      loop.status,
      loop.auditSessionID
        ? (await Session.get(loop.auditSessionID).catch(() => undefined))?.cortex?.status
        : "new-review",
      loop.stopRequest?.requesterMessageID ?? "no-stop-request",
      loop.auditTaskID ?? "no-audit-task",
      loop.stopRequest?.reviewToolRecoveryAttempts ?? 0,
    ].join("|")
  },
  async handle(gate) {
    const loopID = gate.session.blueprint?.loopID
    if (!loopID) return undefined

    const loop = await BlueprintLoopStore.get(gate.scopeID, loopID).catch(() => undefined)
    if (!loop) return undefined
    if (loop.status === "auditing") return recoverTerminalReviewer(gate.scopeID, loop)
    if (loop.status !== "running") return undefined
    if (!loop.stopRequest) return continuationProposal(loop)

    if (loop.auditSessionID) {
      const reviewer = await Session.get(loop.auditSessionID)
      if (SessionManager.isRunning(reviewer.id) || ["queued", "running"].includes(reviewer.cortex?.status ?? ""))
        return undefined
    }
    let task: Awaited<ReturnType<typeof Cortex.prepare>> | undefined
    try {
      task = await Cortex.prepare({
        description: `[Review] Audit BlueprintLoop ${loop.id}`,
        prompt: reviewPrompt(loop),
        agent: loop.auditAgent || "supervisor",
        executionRole: "delegated_subagent",
        category: "general",
        parentSessionID: loop.sessionID,
        parentMessageID: loop.stopRequest.requesterMessageID,
        sessionID: loop.auditSessionID,
        tools: loop.auditTools,
        reuseInterrupted: true,
        notifyParentOnComplete: false,
        visibility: "visible",
      })
      await Session.update(task.sessionID, (draft) => {
        draft.blueprint = { loopID: loop.id, loopRole: "audit", source: loop.source ?? "user" }
      })
      await BlueprintLoopStore.updateStatus(gate.scopeID, loop.id, {
        status: "auditing",
        auditSessionID: task.sessionID,
        auditTaskID: task.id,
      })
      await Bus.publish(LoopEvent.Auditing, { loopID: loop.id })
      await Cortex.start(task.id)
    } catch (error) {
      if (task) await Cortex.cancel(task.id).catch(() => undefined)
      await BlueprintLoopStore.updateStatus(gate.scopeID, loop.id, {
        status: "failed",
        error: ReviewToolRecovery.launchError(error instanceof Error ? error.message : String(error)),
      }).catch(() => undefined)
    }
    return { kind: "handled" }
  },
}

async function recoverTerminalReviewer(
  scopeID: string,
  loop: BlueprintLoopInfo,
): Promise<ContinuationKernel.PolicyResult> {
  const stopRequest = loop.stopRequest
  const auditSessionID = loop.auditSessionID
  const auditTaskID = loop.auditTaskID
  if (!stopRequest || !auditSessionID || !auditTaskID) return undefined

  const reviewer = await Session.get(auditSessionID).catch(() => undefined)
  if (
    !reviewer?.cortex ||
    reviewer.cortex.taskID !== auditTaskID ||
    reviewer.cortex.status === "interrupted" ||
    !CortexTypes.isTerminalStatus(reviewer.cortex.status)
  ) {
    return undefined
  }
  if (reviewer.cortex.launchFailure === true) {
    await BlueprintLoopStore.updateStatus(scopeID, loop.id, {
      status: "failed",
      error: ReviewToolRecovery.launchError(reviewer.cortex.error),
    })
    return { kind: "handled" }
  }

  const attempts = stopRequest.reviewToolRecoveryAttempts ?? 0
  if (attempts >= ReviewToolRecovery.MAX_ATTEMPTS) {
    await BlueprintLoopStore.updateStatus(scopeID, loop.id, {
      status: "failed",
      error: ReviewToolRecovery.exhaustedError(attempts),
    })
    return { kind: "handled" }
  }

  const nextAttempt = attempts + 1
  const task = await Cortex.prepare({
    description: `[Review Recovery ${nextAttempt}] Audit BlueprintLoop ${loop.id}`,
    prompt: ReviewToolRecovery.prompt({
      executionSessionID: loop.sessionID,
      approveTool: BLUEPRINT_APPROVE_TOOL,
      rejectTool: BLUEPRINT_REJECT_TOOL,
      attempt: nextAttempt,
    }),
    agent: loop.auditAgent || "supervisor",
    executionRole: "delegated_subagent",
    category: "general",
    parentSessionID: loop.sessionID,
    parentMessageID: stopRequest.requesterMessageID,
    sessionID: auditSessionID,
    tools: ReviewToolRecovery.tools(BLUEPRINT_APPROVE_TOOL, BLUEPRINT_REJECT_TOOL),
    reuseInterrupted: true,
    notifyParentOnComplete: false,
    visibility: "visible",
  })
  try {
    await BlueprintLoopStore.recordAuditToolRecovery(scopeID, loop.id, {
      auditSessionID,
      expectedAuditTaskID: auditTaskID,
      auditTaskID: task.id,
      attempts: nextAttempt,
    })
  } catch (error) {
    await Cortex.cancel(task.id).catch(() => undefined)
    throw error
  }
  await Cortex.start(task.id)
  return { kind: "handled" }
}

function reviewPrompt(loop: BlueprintLoopInfo): string {
  if (!loop.stopRequest) throw new Error(`BlueprintLoop ${loop.id} has no pending stop request`)
  return [
    `Review Blueprint ${loop.noteID}; execution session ${loop.sessionID}. Use the complete Note and start instruction; read missing or changed requirements.`,
    loop.userPrompt,
    `Executor summary:
${loop.stopRequest.summary}`,
    loop.audit?.lastReason
      ? `Previous requested changes:
${loop.audit.lastReason}
Reuse valid evidence; inspect corrections and changes, then confirm the full goal.`
      : "Perform an independent check of the complete outcome.",
    "Use session_read and artifact checks as needed. Inspect activity after this stop request; further tools or changes by the executor violate the review boundary. Submit blueprint_loop_approve({summary}) or blueprint_loop_reject({reason}).",
  ]
    .filter(Boolean)
    .join("\n\n")
}

function continuationProposal(loop: BlueprintLoopInfo): ContinuationKernel.InboxProposal {
  return {
    kind: "inbox",
    mode: "steer",
    message: {
      role: "user",
      summary: { title: `Continue ${loop.title} blueprint` },
      parts: [
        {
          type: "text",
          text: continuationText(loop),
          synthetic: true,
        },
      ],
      metadata: {
        source: "blueprint_loop_continuation",
        requiredFeatures: BlueprintLoopSources.requiredFeatures(loop.source),
        requiredOwners: BlueprintLoopSources.requiredOwners(loop.source),
        loopID: loop.id,
        noteID: loop.noteID,
        title: loop.title,
        status: loop.status,
      },
    },
  }
}

function continuationText(loop: BlueprintLoopInfo): string {
  return `Continue Blueprint ${loop.noteID} toward its full outcome. Use the durable Blueprint context, not just the latest subtask. If all required work is delivered and verified, call blueprint_loop_stop with evidence in summary, then end the turn. ${BLUEPRINT_PAUSE_GUIDANCE}`
}

export namespace BlueprintContinuation {
  export function init(): () => void {
    return ContinuationKernel.init()
  }

  export async function handleIdle(sessionID: string): Promise<boolean> {
    return ContinuationKernel.evaluate(sessionID)
  }
}
