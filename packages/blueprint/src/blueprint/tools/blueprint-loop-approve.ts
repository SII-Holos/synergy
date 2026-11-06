import { z } from "zod"
import { BlueprintLoopStore } from "../index"
import { LoopEvent } from "../event"
import { Bus } from "@ericsanchezok/synergy-harness/bus"
import { Identifier } from "@ericsanchezok/synergy-harness/id/id"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { BlueprintLoopReviewAccess } from "../review-access"
import { SessionManager } from "@ericsanchezok/synergy-harness/session/manager"
import DESCRIPTION from "./blueprint-loop-approve.txt"
import { Tool } from "@ericsanchezok/synergy-harness/tool/tool"
import { BlueprintLoopSources } from "../source"

const parameters = z.object({
  summary: z.string().describe("Concise acceptance verdict, decisive checks and evidence references."),
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

export const BlueprintLoopApproveTool = Tool.define("blueprint_loop_approve", {
  description: DESCRIPTION,
  parameters,
  async execute(params, ctx) {
    ctx.abort.throwIfAborted()
    const summary = params.summary.trim()
    if (!summary) throw new Error("summary is required")

    const context = await BlueprintLoopReviewAccess.resolve({ agent: ctx.agent, reviewSessionID: ctx.sessionID })
    ctx.abort.throwIfAborted()
    if (!context) throw new Error("Only the recorded reviewer session may approve this BlueprintLoop review")
    const { loop } = context
    const scopeID = ScopeContext.current.scope.id

    const completionText = completionNotificationText({ loopID: loop.id, summary, userPrompt: loop.userPrompt })

    await BlueprintLoopStore.updateStatus(scopeID, loop.id, { status: "completed", summary })
    await Bus.publish(LoopEvent.Completed, { loopID: loop.id })
    if (loop.source !== "lattice") {
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
            requiredFeatures: BlueprintLoopSources.requiredFeatures(loop.source),
            requiredOwners: BlueprintLoopSources.requiredOwners(loop.source),
            source: "blueprint_loop_completed",
            sourceSessionID: ctx.sessionID,
            loopID: loop.id,
            noteID: loop.noteID,
            title: loop.title,
            status: "completed",
            summary,
            ...(loop.userPrompt ? { userPrompt: loop.userPrompt } : {}),
          },
        },
      })
    }

    return {
      title: "BlueprintLoop approved",
      output: completionText,
      metadata: {
        sessionID: loop.sessionID,
        loopID: loop.id,
        loopApproved: true,
        requiredFeatures: BlueprintLoopSources.requiredFeatures(loop.source),
      },
    }
  },
})
