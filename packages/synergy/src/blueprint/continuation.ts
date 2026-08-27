import { LoopEvent } from "./event"
import { Bus } from "../bus"
import { Cortex, CortexTypes } from "../cortex"
import { Session } from "../session"
import { BlueprintLoopStore, type Info as BlueprintLoopInfo } from "."
import { ContinuationKernel } from "../session/continuation-kernel"
import { ReviewToolRecovery } from "../session/review-tool-recovery"

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
        tools: loop.auditTools,
        reuseInterrupted: true,
        notifyParentOnComplete: false,
        visibility: "visible",
      })
      await Session.update(task.sessionID, (draft) => {
        draft.blueprint = { loopID: loop.id, loopRole: "audit" }
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
  const stopRequest = loop.stopRequest
  if (!stopRequest) throw new Error(`BlueprintLoop ${loop.id} has no pending stop request`)
  return [
    "## Task",
    `Audit BlueprintLoop ${loop.id}.`,
    "",
    "## Blueprint",
    `Note ID: ${loop.noteID}. Read the complete Blueprint with note_read.`,
    loop.userPrompt ? "" : undefined,
    loop.userPrompt ? "## Start user instruction" : undefined,
    loop.userPrompt,
    "",
    "## Stop request",
    `**Summary:** ${stopRequest.summary}`,
    stopRequest.completed?.length
      ? `**Completed:**\n${stopRequest.completed.map((item) => `- ${item}`).join("\n")}`
      : "",
    stopRequest.evidence?.length ? `**Evidence:**\n${stopRequest.evidence.map((item) => `- ${item}`).join("\n")}` : "",
    stopRequest.remaining?.length
      ? `**Remaining:**\n${stopRequest.remaining.map((item) => `- ${item}`).join("\n")}`
      : "**Remaining:** none claimed",
    "",
    "## Execution session",
    `Session ID: ${loop.sessionID}. Use session_read to inspect the execution trajectory.`,
    "",
    "## Instructions",
    "1. Inspect the Blueprint, start user instruction, execution trajectory, delivered artifacts, workspace changes, and domain-appropriate verification evidence.",
    "2. Treat Change Scope, boundaries, and non-goals as review requirements, not optional advice. Unauthorized adjacent work is a scope defect, not an acceptable superset.",
    loop.source === "lattice"
      ? "3. This loop owns exactly one current Lattice Step. Implementation of future Lattice Pathway steps is unauthorized even when it appears useful or already passes tests."
      : "3. Verify that delivered work stays within the Blueprint and start-instruction scope.",
    "4. Inspect the trajectory after the first successful blueprint_loop_stop. If the execution session called more tools, modified artifacts, assisted review, or began adjacent work after that stop request, reject with a concrete scope and lifecycle violation.",
    "5. Map every requirement to concrete evidence and classify any gap as blocking or non-blocking.",
    "6. If all required outcomes are complete, verified, in scope, and lifecycle-correct, call blueprint_loop_approve with the execution session ID and a verdict summary.",
    "7. If anything required is missing, incorrect, unverified, out of scope, or performed after the stop boundary, call blueprint_loop_reject with concrete remaining work and instructions.",
  ]
    .filter((line): line is string => line !== undefined && line !== "")
    .join("\n")
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
        loopID: loop.id,
        noteID: loop.noteID,
        title: loop.title,
        status: loop.status,
      },
    },
  }
}

function continuationText(loop: BlueprintLoopInfo): string {
  return [
    `BlueprintLoop ${loop.id} status is \`running\`.`,
    "",
    `A normal final response does not finish this loop. Inspect the Blueprint note (${loop.noteID}), any start user instruction, the current delivered state, and any domain-appropriate quality evidence before deciding what to do next.`,
    loop.source === "lattice"
      ? "This BlueprintLoop owns exactly one current Lattice Step. Future Pathway Steps are context only, not authorization. Earlier user language such as “continue” means continue this current Blueprint, never advance into a later Step."
      : "",
    loop.userPrompt ? `Start user instruction: ${loop.userPrompt}` : "",
    loop.userPrompt ? `This start user instruction is run-specific contract for execution and audit.` : "",
    "",
    `If the Blueprint outcome is not complete, continue the remaining execution work now.`,
    `If the Blueprint outcome is complete and verified, call blueprint_loop_stop with a concise summary, completed requirements, concrete evidence, and any known limitations to request independent review.`,
    "After blueprint_loop_stop succeeds, execution work is closed: do not call another tool or modify anything, and end the assistant turn immediately so the reviewer can start.",
  ]
    .filter(Boolean)
    .join("\n")
}

export namespace BlueprintContinuation {
  export function init(): () => void {
    return ContinuationKernel.init()
  }

  export async function handleIdle(sessionID: string): Promise<boolean> {
    return ContinuationKernel.evaluate(sessionID)
  }
}
