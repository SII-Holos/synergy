import z from "zod"
import { Tool } from "./tool"
import { Session } from "../session"
import DESCRIPTION from "./loop-stop.txt"

const parameters = z.object({
  summary: z.string().describe("Summary of what was completed."),
  completed: z.array(z.string()).optional().describe("Completed deliverable or requirement statements."),
  evidence: z
    .array(z.string())
    .optional()
    .describe("Concrete verification evidence (test results, file paths, checks)."),
  remaining: z.array(z.string()).optional().describe("Any known remaining work or limitations."),
})

export const LoopStopTool = Tool.define("loop_stop", {
  description: DESCRIPTION,
  parameters,
  async execute(params, ctx) {
    const session = await Session.get(ctx.sessionID)
    if (session.workflow?.kind !== "lightloop") {
      throw new Error("No active Light Loop workflow on this session")
    }

    const summary = params.summary.trim()
    if (!summary) throw new Error("summary is required")

    // Idempotency: don't launch a second reviewer while one is pending
    if (session.workflow.stopRequest?.reviewSessionID) {
      return {
        title: "Light Loop review already requested",
        output: `A review was already requested for this Light Loop task. The reviewer is session \`${session.workflow.stopRequest.reviewSessionID}\`.`,
        metadata: {
          loopStopRequested: true,
          reviewTaskID: session.workflow.stopRequest.reviewTaskID,
          reviewSessionID: session.workflow.stopRequest.reviewSessionID,
        },
      }
    }

    const { Cortex } = await import("../cortex")

    const taskDescription = session.workflow.taskDescription
    const reviewPrompt = [
      "## Task",
      "Audit this LightLoop stop request.",
      "",
      "## Original task description",
      taskDescription,
      "",
      "## Stop request",
      `**Summary:** ${summary}`,
      params.completed?.length ? `**Completed:**\n${params.completed.map((c) => `- ${c}`).join("\n")}` : "",
      params.evidence?.length ? `**Evidence:**\n${params.evidence.map((e) => `- ${e}`).join("\n")}` : "",
      params.remaining?.length
        ? `**Remaining:**\n${params.remaining.map((r) => `- ${r}`).join("\n")}`
        : "**Remaining:** none claimed",
      "",
      "## Execution session",
      `Session ID: ${ctx.sessionID}. Use session_read to inspect the execution trajectory.`,
      "",
      "## Instructions",
      "1. Inspect the execution session trajectory and workspace evidence.",
      "2. Verify every explicit requirement and implied deliverable against the task.",
      "3. If all work is complete and verified, call light_loop_approve with the execution session ID and a verdict summary.",
      "4. If any work is missing, partially done, or unverified, call light_loop_reject with concrete remaining instructions.",
    ]
      .filter(Boolean)
      .join("\n")

    // Launch reviewer before persisting stop request — nothing to roll back on failure
    const task = await Cortex.launch({
      description: `[Review] Review LightLoop: ${taskDescription.slice(0, 80)}`,
      prompt: reviewPrompt,
      agent: "lightloop-reviewer",
      executionRole: "delegated_subagent",
      category: "general",
      parentSessionID: ctx.sessionID,
      parentMessageID: ctx.messageID,
      notifyParentOnComplete: false,
      visibility: "hidden",
    })

    // Atomic single write: stopRequest + reviewTaskID + reviewSessionID together.
    // No window where stopRequest exists without reviewSessionID.
    const requestedAt = Date.now()
    let stopRequestRecorded = false
    try {
      await Session.update(ctx.sessionID, (draft) => {
        if (draft.workflow?.kind !== "lightloop") return
        draft.workflow = {
          ...draft.workflow,
          stopRequest: {
            summary,
            completed: params.completed,
            evidence: params.evidence,
            remaining: params.remaining,
            requestedAt,
            requesterSessionID: ctx.sessionID,
            requesterMessageID: ctx.messageID,
            reviewTaskID: task.id,
            reviewSessionID: task.sessionID,
          },
        }
        stopRequestRecorded = true
      })
      if (!stopRequestRecorded) throw new Error("Failed to record Light Loop stop request")
    } catch (error) {
      await Cortex.cancel(task.id).catch(() => {})
      throw error
    }

    const output = `Light Loop stop review requested. The reviewer is session \`${task.sessionID}\`.`
    return {
      title: "Light Loop review requested",
      output,
      metadata: { loopStopRequested: true, reviewTaskID: task.id, reviewSessionID: task.sessionID },
    }
  },
})
