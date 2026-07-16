import z from "zod"
import { AgendaSessionWakeup } from "../agenda/session-wakeup"
import { BlueprintLoopStore, LoopError } from "../blueprint"
import { LoopEvent } from "../blueprint/event"
import { Bus } from "../bus"
import { ScopeContext } from "../scope/context"
import { Session } from "../session"
import DESCRIPTION from "./blueprint-loop-stop.txt"
import { Tool } from "./tool"

const parameters = z.object({
  summary: z.string().describe("Summary of what was completed."),
  completed: z.array(z.string()).optional().describe("Completed Blueprint requirement statements."),
  evidence: z
    .array(z.string())
    .optional()
    .describe("Concrete verification evidence such as checks, artifacts, and file paths."),
  remaining: z.array(z.string()).optional().describe("Any known remaining work or limitations."),
})

function startUserInstructionBlock(userPrompt?: string): string {
  if (!userPrompt) return ""
  return ["", "## Start user instruction", userPrompt].join("\n")
}

export const BlueprintLoopStopTool = Tool.define("blueprint_loop_stop", {
  description: DESCRIPTION,
  parameters,
  async execute(params, ctx) {
    const session = await Session.get(ctx.sessionID)
    const loopID = session.blueprint?.loopID
    if (!loopID || session.blueprint?.loopRole !== "execution") {
      throw new Error("Only the BlueprintLoop execution session may request review")
    }

    const scopeID = ScopeContext.current.scope.id
    const loop = await BlueprintLoopStore.get(scopeID, loopID).catch(() => {
      throw new LoopError.NotFound({ id: loopID })
    })
    if (loop.sessionID !== ctx.sessionID) {
      throw new Error("Only the BlueprintLoop execution session may request review")
    }

    if (loop.status === "auditing" && loop.auditSessionID) {
      return {
        title: "BlueprintLoop review already requested",
        output: `A review was already requested for this BlueprintLoop. The reviewer is session \`${loop.auditSessionID}\`. Do not call any tools to check on it — the reviewer will deliver results directly to this session when the audit completes.`,
        metadata: {
          loopStopRequested: true,
          reviewTaskID: loop.auditTaskID,
          reviewSessionID: loop.auditSessionID,
        },
      }
    }
    if (loop.status !== "running") {
      throw new Error(`Cannot request review for BlueprintLoop ${loop.id} while its status is "${loop.status}"`)
    }

    const summary = params.summary.trim()
    if (!summary) throw new Error("summary is required")
    await AgendaSessionWakeup.assertClear({
      sessionID: ctx.sessionID,
      scopeID,
      operation: "BlueprintLoop audit",
    })

    const reviewPrompt = [
      "## Task",
      `Audit BlueprintLoop ${loop.id}.`,
      "",
      "## Blueprint",
      `Note ID: ${loop.noteID}. Read the complete Blueprint with note_read.`,
      startUserInstructionBlock(loop.userPrompt),
      "",
      "## Stop request",
      `**Summary:** ${summary}`,
      params.completed?.length ? `**Completed:**\n${params.completed.map((item) => `- ${item}`).join("\n")}` : "",
      params.evidence?.length ? `**Evidence:**\n${params.evidence.map((item) => `- ${item}`).join("\n")}` : "",
      params.remaining?.length
        ? `**Remaining:**\n${params.remaining.map((item) => `- ${item}`).join("\n")}`
        : "**Remaining:** none claimed",
      "",
      "## Execution session",
      `Session ID: ${ctx.sessionID}. Use session_read to inspect the execution trajectory.`,
      "",
      "## Instructions",
      "1. Inspect the Blueprint, start user instruction, execution trajectory, delivered artifacts, workspace changes, and domain-appropriate verification evidence.",
      "2. Map every requirement to concrete evidence and classify any gap as blocking or non-blocking.",
      "3. If all required outcomes are complete and verified, call blueprint_loop_approve with the execution session ID and a verdict summary.",
      "4. If anything required is missing, incorrect, or unverified, call blueprint_loop_reject with concrete remaining work and instructions.",
    ]
      .filter(Boolean)
      .join("\n")

    const { Cortex } = await import("../cortex")
    const task = await Cortex.launch({
      description: `[Review] Audit BlueprintLoop ${loop.id}`,
      prompt: reviewPrompt,
      agent: loop.auditAgent || "supervisor",
      executionRole: "delegated_subagent",
      category: "general",
      parentSessionID: loop.sessionID,
      parentMessageID: ctx.messageID,
      notifyParentOnComplete: false,
      visibility: "hidden",
    })

    try {
      await Session.update(task.sessionID, (draft) => {
        draft.blueprint = { loopID: loop.id, loopRole: "audit" }
      })
      await BlueprintLoopStore.updateStatus(scopeID, loop.id, {
        status: "auditing",
        auditSessionID: task.sessionID,
        auditTaskID: task.id,
      })
      await Bus.publish(LoopEvent.Auditing, { loopID: loop.id })
    } catch (error) {
      await Cortex.cancel(task.id).catch(() => undefined)
      await Session.update(task.sessionID, (draft) => {
        draft.blueprint = undefined
      }).catch(() => undefined)
      throw error
    }

    return {
      title: "BlueprintLoop review requested",
      output: `BlueprintLoop review requested. The reviewer is session \`${task.sessionID}\`. Do not call any tools to check on it — the reviewer will deliver results directly to this session when the audit completes.`,
      metadata: { loopStopRequested: true, reviewTaskID: task.id, reviewSessionID: task.sessionID },
    }
  },
})
