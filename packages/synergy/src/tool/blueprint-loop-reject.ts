import z from "zod"
import { BlueprintLoopStore, LoopError } from "../blueprint"
import { LoopEvent } from "../blueprint/event"
import { Bus } from "../bus"
import { Identifier } from "../id/id"
import { ScopeContext } from "../scope/context"
import { Session } from "../session"
import { BlueprintLoopReviewAccess } from "../session/blueprint-loop-review-access"
import { SessionManager } from "../session/manager"
import DESCRIPTION from "./blueprint-loop-reject.txt"
import { Tool } from "./tool"

const parameters = z.object({
  sessionID: z.string().describe("The execution session ID provided in your launch context"),
  reason: z.string().describe("Clear explanation of why the Blueprint outcome is not complete"),
  completed: z.string().optional().describe("Optional summary of work that is already correct"),
  remaining: z.string().describe("Missing or incorrect work, marking each item BLOCKING or NON-BLOCKING"),
  instructions: z.string().describe("Concrete next actions the execution agent can follow without clarification"),
})

export const BlueprintLoopRejectTool = Tool.define("blueprint_loop_reject", {
  description: DESCRIPTION,
  parameters,
  async execute(params, ctx) {
    const reason = params.reason.trim()
    const remaining = params.remaining.trim()
    const instructions = params.instructions.trim()
    if (!reason) throw new Error("reason is required")
    if (!remaining) throw new Error("remaining is required")
    if (!instructions) throw new Error("instructions is required")

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
      action: "reject",
    })

    const audit = {
      lastReason: reason,
      lastAuditedAt: Date.now(),
      attempts: (loop.audit?.attempts ?? 0) + 1,
    }
    await BlueprintLoopStore.updateStatus(scopeID, loop.id, { status: "running", audit })
    await Bus.publish(LoopEvent.Rejected, { loopID: loop.id, reason })

    const text = [
      `BlueprintLoop ${loop.id} review requested changes.`,
      "",
      `**Reason:** ${reason}`,
      params.completed?.trim() ? `\n**Completed:**\n${params.completed.trim()}` : "",
      `\n**Remaining:**\n${remaining}`,
      `\n**Instructions:**\n${instructions}`,
    ]
      .filter(Boolean)
      .join("\n")

    await SessionManager.deliver({
      target: loop.sessionID,
      waitForProcessing: false,
      mail: {
        type: "user",
        summary: { title: "Blueprint review requested changes" },
        parts: [
          {
            id: Identifier.ascending("part"),
            sessionID: loop.sessionID,
            messageID: "",
            type: "text",
            text,
            origin: "system",
          },
        ],
        metadata: {
          source: "blueprint_loop_rejected",
          sourceSessionID: ctx.sessionID,
          loopID: loop.id,
          noteID: loop.noteID,
          title: loop.title,
          reason,
          completed: params.completed,
          remaining,
          instructions,
        },
      },
    })

    return {
      title: "BlueprintLoop rejected",
      output: text,
      metadata: {
        sessionID: loop.sessionID,
        loopID: loop.id,
        loopRejected: true,
        attempts: audit.attempts,
      },
    }
  },
})
