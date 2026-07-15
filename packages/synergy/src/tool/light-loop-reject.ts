import z from "zod"
import { Tool } from "./tool"
import { Session } from "../session"
import { SessionManager } from "../session/manager"
import { Identifier } from "../id/id"
import DESCRIPTION from "./light-loop-reject.txt"
import { LightLoopReviewAccess } from "@/session/light-loop-review-access"
import { LightLoopRuntime } from "@/session/light-loop-runtime"

const parameters = z.object({
  sessionID: z.string().describe("The execution session ID provided in your launch context"),
  reason: z.string().describe("Clear explanation of why the task is not complete"),
  completed: z.string().optional().describe("Optional summary of work that is already correct"),
  remaining: z.string().describe("Summary of missing or incorrect work, marking each item BLOCKING or NON-BLOCKING"),
  instructions: z
    .string()
    .describe("Concrete next actions the execution agent can follow without further clarification"),
})

export const LightLoopRejectTool = Tool.define("light_loop_reject", {
  description: DESCRIPTION,
  parameters,
  async execute(params, ctx) {
    const sessionID = params.sessionID
    const reason = params.reason.trim()
    const remaining = params.remaining.trim()
    const instructions = params.instructions.trim()
    if (!reason) throw new Error("reason is required")
    if (!remaining) throw new Error("remaining is required")
    if (!instructions) throw new Error("instructions is required")
    const target = await Session.get(sessionID)
    if (!target) throw new Error(`Session ${sessionID} not found`)

    if (!target.workflow || target.workflow.kind !== "lightloop") {
      throw new Error(`Session ${sessionID} does not have an active Light Loop workflow`)
    }

    const stopRequest = target.workflow.stopRequest
    if (!stopRequest) throw new Error(`Session ${sessionID} has no pending stop request`)

    await LightLoopReviewAccess.assertForTarget({
      agent: ctx.agent,
      reviewSessionID: ctx.sessionID,
      targetSessionID: sessionID,
      action: "reject",
    })

    const currentAttempts = target.workflow.review?.attempts ?? 0
    const maxIterations = target.workflow.budget?.maxIterations
    const now = Date.now()

    // Check maxIterations exhaustion — use single terminal path
    if (maxIterations !== undefined && currentAttempts + 1 >= maxIterations) {
      // Update review state, then transition to iteration_exhausted
      await Session.update(sessionID, (draft) => {
        if (draft.workflow?.kind !== "lightloop") return
        draft.workflow = {
          ...draft.workflow,
          stopRequest: undefined,
          review: {
            attempts: currentAttempts + 1,
            lastReason: reason,
            lastReviewedAt: now,
          },
        }
      })

      await LightLoopRuntime.setTerminalStatus(sessionID, "iteration_exhausted")

      const exhaustText = `Light Loop review rejected — maximum iterations (${maxIterations}) reached.\n\n**Final rejection:** ${reason}\n\n**Remaining:**\n${remaining}`
      await SessionManager.deliver({
        target: sessionID,
        mail: {
          type: "user",
          summary: { title: "Light Loop review exhausted" },
          parts: [
            {
              id: Identifier.ascending("part"),
              sessionID,
              messageID: "",
              type: "text",
              text: exhaustText,
              origin: "system",
            },
          ],
          metadata: { source: "light_loop_exhausted", sourceSessionID: ctx.sessionID },
        },
      })
      return {
        title: "Light Loop review exhausted",
        output: exhaustText,
        metadata: { sessionID, loopRejected: true, loopExhausted: true, attempts: currentAttempts + 1 },
      }
    }

    // Normal reject: reviewing → running, attempts +1, same execution session
    // Retain the same execution session (do not create new one).
    await Session.update(sessionID, (draft) => {
      if (draft.workflow?.kind !== "lightloop") return
      draft.workflow = {
        ...draft.workflow,
        status: "running",
        stopRequest: undefined,
        review: {
          attempts: currentAttempts + 1,
          lastReason: reason,
          lastReviewedAt: now,
        },
      }
    })

    const text = [
      "Light Loop review requested changes.",
      "",
      `**Reason:** ${reason}`,
      params.completed ? `\n**Completed:**\n${params.completed}` : "",
      `\n**Remaining:**\n${remaining}`,
      `\n**Instructions:**\n${instructions}`,
    ]
      .filter(Boolean)
      .join("\n")

    await SessionManager.deliver({
      target: sessionID,
      mail: {
        type: "user",
        summary: { title: "Light Loop review requested changes" },
        parts: [
          {
            id: Identifier.ascending("part"),
            sessionID,
            messageID: "",
            type: "text",
            text,
            origin: "system",
          },
        ],
        metadata: { source: "light_loop_rejected", sourceSessionID: ctx.sessionID },
      },
    })

    return {
      title: "Light Loop rejected",
      output: text,
      metadata: { sessionID, loopRejected: true, loopExhausted: false, attempts: currentAttempts + 1 },
    }
  },
})
