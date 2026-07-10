import z from "zod"
import { BlueprintLoopStore, LoopError } from "../blueprint"
import { LoopEvent } from "../blueprint/event"
import { Bus } from "../bus"
import { Identifier } from "../id/id"
import { LatticeStore } from "../lattice/store"
import type { LatticeTypes } from "../lattice/types"
import { ScopeContext } from "../scope/context"
import { Session } from "../session"
import { BlueprintLoopReviewAccess } from "../session/blueprint-loop-review-access"
import { SessionManager } from "../session/manager"
import DESCRIPTION from "./blueprint-loop-approve.txt"
import { Tool } from "./tool"

const parameters = z.object({
  sessionID: z.string().describe("The execution session ID provided in your launch context"),
  summary: z.string().describe("Concise approved completion verdict"),
})

function completionNotificationText(input: { loopID: string; summary: string; userPrompt?: string }) {
  return [
    `BlueprintLoop ${input.loopID} passed review and is now complete.`,
    `Audit summary: ${input.summary}`,
    input.userPrompt ? `Start user instruction: ${input.userPrompt}` : "",
    "No further BlueprintLoop review action is available for this completed loop.",
    "If there is user-requested final follow-up outside the BlueprintLoop, perform the allowed follow-up now. Otherwise, summarize completion for the user.",
  ]
    .filter(Boolean)
    .join("\n")
}

function latticeCompletionText(input: { loopID: string; runID: string; summary: string; userPrompt?: string }) {
  return [
    `BlueprintLoop ${input.loopID} passed review and is now complete.`,
    `Audit summary: ${input.summary}`,
    input.userPrompt ? `Start user instruction: ${input.userPrompt}` : "",
    "",
    `This Blueprint is a step of Lattice run ${input.runID}. You are now in the result_analysis phase.`,
    "Call pathway_read to confirm the current phase and step, then record this step's result on the Pathway with pathway_patch (result summary, and any forward recovery step if follow-up work emerged).",
    "Do not stop to write a user-facing wrap-up; continue advancing the Lattice Pathway. No further BlueprintLoop review action is available for this completed loop.",
  ]
    .filter(Boolean)
    .join("\n")
}

async function latticeRunForLoop(scopeID: string, loop: { id: string; sessionID: string }): Promise<LatticeTypes.Run> {
  const run = await LatticeStore.getOrUndefined(scopeID, loop.sessionID)
  if (!run) {
    throw new Error(`Lattice-owned BlueprintLoop ${loop.id} has no current Lattice run for session ${loop.sessionID}.`)
  }
  if (!run.pathway.some((step) => step.blueprintLoopID === loop.id)) {
    throw new Error(`Lattice-owned BlueprintLoop ${loop.id} is not referenced by current Lattice run ${run.id}.`)
  }
  return run
}

export const BlueprintLoopApproveTool = Tool.define("blueprint_loop_approve", {
  description: DESCRIPTION,
  parameters,
  async execute(params, ctx) {
    const summary = params.summary.trim()
    if (!summary) throw new Error("summary is required")

    const executionSession = await Session.get(params.sessionID)
    const loopID = executionSession.blueprint?.loopID
    if (!loopID || executionSession.blueprint?.loopRole !== "execution") {
      throw new Error(`Session ${params.sessionID} does not have an active BlueprintLoop execution`)
    }

    const scopeID = ScopeContext.current.scope.id
    const loop = await BlueprintLoopStore.get(scopeID, loopID).catch(() => {
      throw new LoopError.NotFound({ id: loopID })
    })
    if (loop.status !== "auditing" || !loop.auditSessionID) {
      throw new Error(`BlueprintLoop ${loop.id} has no pending review`)
    }

    await BlueprintLoopReviewAccess.assertForTarget({
      agent: ctx.agent,
      reviewSessionID: ctx.sessionID,
      targetSessionID: params.sessionID,
      action: "approve",
    })

    const latticeRun = loop.source === "lattice" ? await latticeRunForLoop(scopeID, loop) : undefined
    const completionText = latticeRun
      ? latticeCompletionText({ loopID: loop.id, runID: latticeRun.id, summary, userPrompt: loop.userPrompt })
      : completionNotificationText({ loopID: loop.id, summary, userPrompt: loop.userPrompt })

    await BlueprintLoopStore.updateStatus(scopeID, loop.id, { status: "completed" })
    await Bus.publish(LoopEvent.Completed, { loopID: loop.id })
    await SessionManager.deliver({
      target: loop.sessionID,
      waitForProcessing: false,
      mail: {
        type: "user",
        ...(loop.executionAgent ? { agent: loop.executionAgent } : {}),
        summary: { title: "Blueprint review approved" },
        parts: [
          {
            id: Identifier.ascending("part"),
            sessionID: loop.sessionID,
            messageID: "",
            type: "text",
            text: completionText,
            origin: "system",
          },
        ],
        metadata: {
          source: "blueprint_loop_completed",
          sourceSessionID: ctx.sessionID,
          loopID: loop.id,
          noteID: loop.noteID,
          title: loop.title,
          status: "completed",
          summary,
          ...(latticeRun ? { latticeRunID: latticeRun.id } : {}),
          ...(loop.userPrompt ? { userPrompt: loop.userPrompt } : {}),
        },
      },
    })

    return {
      title: "BlueprintLoop approved",
      output: completionText,
      metadata: { sessionID: loop.sessionID, loopID: loop.id, loopApproved: true },
    }
  },
})
