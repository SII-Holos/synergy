import { LoopEvent } from "../blueprint/event"
import { Bus } from "../bus"
import { Cortex } from "../cortex"
import { Session } from "./index"
import { BlueprintLoopStore, type Info as BlueprintLoopInfo } from "../blueprint"
import { ContinuationKernel } from "./continuation-kernel"

export const BlueprintContinuationPolicy: ContinuationKernel.Policy = {
  id: "blueprint_loop",
  priority: 100,
  async handle(gate) {
    const loopID = gate.session.blueprint?.loopID
    if (!loopID) return undefined

    const loop = await BlueprintLoopStore.get(gate.scopeID, loopID).catch(() => undefined)
    if (!loop || loop.status !== "running") return undefined
    if (!loop.stopRequest) return continuationProposal(loop)

    const task = await Cortex.prepare({
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
    return { kind: "handled" }
  },
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
    "1. Audit both outcome completeness and trajectory conformance. Inspect the Blueprint, start user instruction, execution trajectory, delivered artifacts, workspace changes, and domain-appropriate verification evidence.",
    "2. Compare the actual route against the Blueprint's chosen implementation route, rejected alternatives, preserved behavior, change scope, and boundaries. Map every requirement to concrete evidence and classify any gap as blocking or non-blocking.",
    "3. Reject a materially different implementation route, unexpected ownership or duplication, forbidden fallback or compatibility path, or unrelated expansion even when the requested outcome is complete and tests pass.",
    "4. If all required outcomes are complete, verified, and trajectory-conformant, call blueprint_loop_approve with the execution session ID and a verdict summary.",
    "5. If anything required is missing, incorrect, unverified, or non-conformant, call blueprint_loop_reject with concrete remaining work and instructions.",
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
    loop.userPrompt ? `Start user instruction: ${loop.userPrompt}` : "",
    loop.userPrompt ? `This start user instruction is run-specific contract for execution and audit.` : "",
    "",
    `If the Blueprint outcome is not complete, continue the remaining execution work now.`,
    `If the Blueprint outcome is complete and verified, call blueprint_loop_stop with a concise summary, completed requirements, concrete evidence, and any known limitations to request independent review.`,
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
