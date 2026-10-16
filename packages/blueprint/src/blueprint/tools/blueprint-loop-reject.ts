import { z } from "zod"
import { BlueprintLoopSources } from "../source"
import { BlueprintLoopStore } from "../index"
import { LoopEvent } from "../event"
import { Bus } from "@ericsanchezok/synergy-harness/bus"
import { Identifier } from "@ericsanchezok/synergy-harness/id/id"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { BlueprintLoopReviewAccess } from "../review-access"
import { SessionManager } from "@ericsanchezok/synergy-harness/session/manager"
import { isIterationBudgetExhausted } from "@ericsanchezok/synergy-harness/session/iteration-budget"
import DESCRIPTION from "./blueprint-loop-reject.txt"
import { Tool } from "@ericsanchezok/synergy-harness/tool/tool"

const parameters = z.object({
  reason: z
    .string()
    .describe("Unmet requirements, evidence and concrete corrections; distinguish optional suggestions."),
})

export const BlueprintLoopRejectTool = Tool.define("blueprint_loop_reject", {
  description: DESCRIPTION,
  parameters,
  async execute(params, ctx) {
    ctx.abort.throwIfAborted()
    const reason = params.reason.trim()
    if (!reason) throw new Error("reason is required")

    const context = await BlueprintLoopReviewAccess.resolve({ agent: ctx.agent, reviewSessionID: ctx.sessionID })
    ctx.abort.throwIfAborted()
    if (!context) throw new Error("Only the recorded reviewer session may reject this BlueprintLoop review")
    const { loop } = context
    const scopeID = ScopeContext.current.scope.id

    const attempts = (loop.audit?.attempts ?? 0) + 1
    const maxIterations = loop.budget?.maxIterations
    if (isIterationBudgetExhausted(attempts, maxIterations)) {
      // Exhausted — terminalize as failed with iteration_exhausted
      await BlueprintLoopStore.updateStatus(scopeID, loop.id, {
        status: "failed",
        error: "iteration_exhausted: maxIterations budget exceeded",
        audit: {
          lastReason: reason,
          lastAuditedAt: Date.now(),
          attempts,
        },
      })
      await Bus.publish(LoopEvent.Rejected, { loopID: loop.id, reason })
      return {
        title: "BlueprintLoop iteration exhausted",
        output: `Max iterations (${maxIterations}) reached. Loop is now failed with iteration_exhausted.`,
        metadata: {
          requiredFeatures: BlueprintLoopSources.requiredFeatures(loop.source),
          sessionID: loop.sessionID,
          loopID: loop.id,
          loopRejected: true,
          attempts,
          iterationExhausted: true,
        },
      }
    }

    const audit = {
      lastReason: reason,
      lastAuditedAt: Date.now(),
      attempts,
    }

    const text = `BlueprintLoop ${loop.id} review requested changes.
${reason}`

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
          requiredFeatures: BlueprintLoopSources.requiredFeatures(loop.source),
          source: "blueprint_loop_rejected",
          requiredOwners: BlueprintLoopSources.requiredOwners(loop.source),
          sourceSessionID: ctx.sessionID,
          loopID: loop.id,
          noteID: loop.noteID,
          title: loop.title,
          reason,
        },
      },
    })
    await BlueprintLoopStore.updateStatus(scopeID, loop.id, {
      status: "running",
      audit,
    })
    await Bus.publish(LoopEvent.Rejected, { loopID: loop.id, reason })

    return {
      title: "BlueprintLoop rejected",
      output: text,
      metadata: {
        requiredFeatures: BlueprintLoopSources.requiredFeatures(loop.source),
        sessionID: loop.sessionID,
        loopID: loop.id,
        loopRejected: true,
        attempts: audit.attempts,
        iterationExhausted: false,
      },
    }
  },
})
