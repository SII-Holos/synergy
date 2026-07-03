import z from "zod"
import { Tool } from "./tool"
import { BlueprintLoopStore, LoopError } from "../blueprint"
import { ScopeContext } from "../scope/context"
import { Bus } from "../bus"
import { LoopEvent } from "../blueprint/event"
import { Identifier } from "../id/id"
import DESCRIPTION from "./blueprint-loop-finish.txt"
import { SessionManager } from "../session/manager"

const parameters = z.object({
  loopID: z.string().describe("The BlueprintLoop ID to finish."),
  status: z
    .enum(["auditing", "failed", "completed"])
    .describe(
      "The new status — 'auditing' from the execution session, 'completed' from the audit session, or 'failed' from either.",
    ),
  summary: z.string().optional().describe("Optional summary of the finish reason or audit result."),
})

function startUserInstructionBlock(userPrompt?: string): string {
  if (!userPrompt) return ""
  return `

Start user instruction for this run:
${userPrompt}

Treat this start user instruction as part of the BlueprintLoop contract alongside the Blueprint note. If it conflicts with the Blueprint note or cannot be satisfied, classify that as a blocking audit issue and use blueprint_loop_restart with concrete next actions.`
}

function completionNotificationText(input: { loopID: string; summary?: string; userPrompt?: string }) {
  return [
    `BlueprintLoop ${input.loopID} passed supervisor audit and is now complete.`,
    input.summary ? `Audit summary: ${input.summary}` : "",
    input.userPrompt ? `Start user instruction: ${input.userPrompt}` : "",
    `Do not call blueprint_loop_finish or blueprint_loop_restart for this loop again; the loop is already complete.`,
    `If there is user-requested final follow-up outside the BlueprintLoop, perform the allowed follow-up now. Otherwise, summarize completion for the user.`,
  ]
    .filter(Boolean)
    .join("\n")
}

export const BlueprintLoopFinishTool = Tool.define("blueprint_loop_finish", {
  description: DESCRIPTION,
  parameters,
  async execute(params: z.infer<typeof parameters>, ctx) {
    const scopeID = ScopeContext.current.scope.id

    try {
      await BlueprintLoopStore.get(scopeID, params.loopID)
    } catch {
      throw new LoopError.NotFound({ id: params.loopID })
    }

    // Pre-check loop status for terminal and idempotent states
    const loop = await BlueprintLoopStore.get(scopeID, params.loopID)
    const currentStatus = loop.status
    const isExecutionSession = ctx.sessionID === loop.sessionID
    const isAuditSession = ctx.sessionID === loop.auditSessionID

    if (params.status === "auditing" && !isExecutionSession) {
      throw new Error(
        `Session "${ctx.sessionID}" cannot move BlueprintLoop ${params.loopID} to auditing. Only the execution session ${loop.sessionID} can request audit.`,
      )
    }
    if (params.status === "completed" && !isAuditSession) {
      throw new Error(
        `Session "${ctx.sessionID}" cannot complete BlueprintLoop ${params.loopID}. Only the active audit session can complete it.`,
      )
    }
    if (params.status === "failed" && !isExecutionSession && !isAuditSession) {
      throw new Error(
        `Session "${ctx.sessionID}" cannot fail BlueprintLoop ${params.loopID}. Only the execution session or active audit session can fail it.`,
      )
    }

    if (currentStatus === "completed") {
      return {
        title: `Loop ${params.loopID} → already completed`,
        output: `BlueprintLoop ${params.loopID} is already completed. Create a new BlueprintLoop if you need to re-run this Blueprint.`,
        metadata: {
          loopID: params.loopID,
          status: "completed",
        },
      }
    }

    if (currentStatus === "failed") {
      return {
        title: `Loop ${params.loopID} → already failed`,
        output: `BlueprintLoop ${params.loopID} is already failed. Create a new BlueprintLoop if you need to re-run this Blueprint.`,
        metadata: {
          loopID: params.loopID,
          status: "failed",
        },
      }
    }

    if (currentStatus === "cancelled") {
      return {
        title: `Loop ${params.loopID} → already cancelled`,
        output: `BlueprintLoop ${params.loopID} is already cancelled. Create a new BlueprintLoop if you need to re-run this Blueprint.`,
        metadata: {
          loopID: params.loopID,
          status: "cancelled",
        },
      }
    }

    if (currentStatus === "auditing" && params.status === "auditing") {
      return {
        title: `Loop ${params.loopID} → already auditing`,
        output: `BlueprintLoop ${params.loopID} is already being audited.`,
        metadata: {
          loopID: params.loopID,
          status: "auditing",
        },
      }
    }
    let auditSessionID: string | undefined

    if (params.status === "auditing") {
      const auditPrompt = `Audit BlueprintLoop ${params.loopID} (Note ${loop.noteID}) in session ${loop.sessionID}.
Read the Blueprint Note via note_read and audit any start user instruction included below. Examine the execution evidence (session trajectory, produced artifacts or workspace changes, and domain-appropriate quality checks), and determine if the Blueprint outcome is complete.
If NOT complete, call blueprint_loop_restart({ loopID: "${params.loopID}", reason: "...", completed: "...", remaining: "...", instructions: "..." }) with a detailed reason and concrete next actions.
If complete, call blueprint_loop_finish({ loopID: "${params.loopID}", status: "completed", summary: "..." }).${startUserInstructionBlock(loop.userPrompt)}`
      const { Cortex } = await import("../cortex")
      const auditAgent = loop.auditAgent || "supervisor"
      const task = await Cortex.launch({
        description: `[Audit] Audit BlueprintLoop ${params.loopID}`,
        prompt: auditPrompt,
        agent: auditAgent,
        executionRole: "delegated_subagent",
        category: "general",
        parentSessionID: loop.sessionID,
        parentMessageID: ctx.messageID,
        notifyParentOnComplete: false,
      })
      auditSessionID = task.sessionID
      const { Session } = await import("../session")
      await Session.update(auditSessionID, (draft) => {
        draft.blueprint = { ...draft.blueprint, loopID: params.loopID, loopRole: "audit" }
      })
      await BlueprintLoopStore.updateStatus(scopeID, params.loopID, {
        status: "auditing",
        auditSessionID,
      })
    } else if (params.status === "failed") {
      await BlueprintLoopStore.updateStatus(scopeID, params.loopID, { status: "failed" })
      await Bus.publish(LoopEvent.Failed, { loopID: params.loopID, error: params.summary ?? "Loop execution failed" })
      const { Cortex } = await import("../cortex")
      await Cortex.cancelAll(ctx.sessionID)
      SessionManager.signalAbort(ctx.sessionID)
    } else if (params.status === "completed") {
      const completionMail: SessionManager.SessionMail.User = {
        type: "user",
        ...(loop.executionAgent ? { agent: loop.executionAgent } : {}),
        summary: { title: "Blueprint audit completed" },
        parts: [
          {
            id: Identifier.ascending("part"),
            sessionID: loop.sessionID,
            messageID: Identifier.ascending("message"),
            type: "text",
            text: completionNotificationText({ loopID: loop.id, summary: params.summary, userPrompt: loop.userPrompt }),
          },
        ],
        metadata: {
          source: "blueprint_loop_completed",
          sourceSessionID: ctx.sessionID,
          loopID: loop.id,
          noteID: loop.noteID,
          title: loop.title,
          status: "completed",
          ...(params.summary ? { summary: params.summary } : {}),
          ...(loop.userPrompt ? { userPrompt: loop.userPrompt } : {}),
        },
      }
      await BlueprintLoopStore.updateStatus(scopeID, params.loopID, { status: "completed" })
      await Bus.publish(LoopEvent.Completed, { loopID: params.loopID })
      await SessionManager.deliver({ target: loop.sessionID, mail: completionMail, waitForProcessing: false })
      const { Cortex } = await import("../cortex")
      await Cortex.cancelAll(ctx.sessionID)
      SessionManager.signalAbort(ctx.sessionID)
    }

    const statusLabel: Record<string, string> = {
      auditing: "auditing",
      failed: "failed",
      completed: "completed",
    }

    return {
      title: `Loop ${params.loopID} → ${params.status}`,
      output: [
        `BlueprintLoop ${params.loopID} is now ${statusLabel[params.status]}.`,
        auditSessionID ? `Audit session: ${auditSessionID}` : "",
        params.summary ? `Summary: ${params.summary}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
      metadata: {
        loopID: params.loopID,
        status: params.status,
        auditSessionID,
      } as Record<string, any>,
    }
  },
})
