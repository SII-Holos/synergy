import z from "zod"
import { Tool } from "./tool"
import { BlueprintLoopStore, LoopError } from "../blueprint"
import { Instance } from "../scope/instance"
import { SessionManager } from "../session/manager"
import { MessageV2 } from "../session/message-v2"
import { Identifier } from "../id/id"
import { Bus } from "../bus"
import { LoopEvent } from "../blueprint/event"
import DESCRIPTION from "./blueprint-loop-restart.txt"

const parameters = z.object({
  loopID: z.string().describe("The BlueprintLoop ID to restart."),
  reason: z.string().describe("Explanation for the restart (will be recorded in the audit trail)."),
  completed: z.string().optional().describe("Optional summary of what was completed successfully."),
  remaining: z.string().optional().describe("Optional summary of remaining work."),
  instructions: z.string().optional().describe("Optional additional instructions for the execution agent."),
})

export const BlueprintLoopRestartTool = Tool.define("blueprint_loop_restart", {
  description: DESCRIPTION,
  parameters,
  async execute(params: z.infer<typeof parameters>, ctx) {
    const scopeID = Instance.scope.id

    let loop
    try {
      loop = await BlueprintLoopStore.get(scopeID, params.loopID)
    } catch {
      throw new LoopError.NotFound({ id: params.loopID })
    }

    if (loop.status !== "auditing") {
      throw new Error(
        `Cannot restart BlueprintLoop ${params.loopID}: expected status "auditing" but current status is "${loop.status}".`,
      )
    }

    const now = Date.now()
    const audit = {
      lastReason: params.reason,
      lastAuditedAt: now,
      attempts: (loop.audit?.attempts ?? 0) + 1,
    }

    await BlueprintLoopStore.updateStatus(scopeID, params.loopID, {
      status: "running",
      audit,
    })

    await Bus.publish(LoopEvent.Restarted, {
      loopID: params.loopID,
      reason: params.reason,
    })

    const messageLines = [
      `[BlueprintLoop Restarted]`,
      params.reason ? `Reason: ${params.reason}` : "",
      params.completed ? `Completed: ${params.completed}` : "",
      params.remaining ? `Remaining: ${params.remaining}` : "",
      params.instructions ? `Instructions: ${params.instructions}` : "",
    ]
      .filter(Boolean)
      .join("\n")

    const textPart: MessageV2.TextPart = {
      id: Identifier.ascending("part"),
      sessionID: loop.sessionID,
      messageID: Identifier.ascending("message"),
      type: "text",
      text: messageLines,
    }

    await ctx.ask({
      permission: "identity_act",
      patterns: [`blueprint_loop_restart session=${loop.sessionID}`],
      metadata: {
        nonBypassable: true,
        action: "blueprint_loop_restart",
        target: loop.sessionID,
      },
    })

    const mail: SessionManager.SessionMail.User = {
      type: "user",
      parts: [textPart],
      metadata: {
        mailbox: true,
        source: "blueprint_loop_restart",
        sourceSessionID: ctx.sessionID,
      },
    }

    await SessionManager.deliver({ target: loop.sessionID, mail })

    return {
      title: `Loop ${params.loopID} restarted`,
      output: [
        `BlueprintLoop ${params.loopID} restarted (attempt ${audit.attempts}).`,
        `Sent message to execution session ${loop.sessionID}.`,
        `Reason: ${params.reason}`,
      ].join("\n"),
      metadata: {
        loopID: params.loopID,
        sessionID: loop.sessionID,
        attempts: audit.attempts,
      } as Record<string, any>,
    }
  },
})
