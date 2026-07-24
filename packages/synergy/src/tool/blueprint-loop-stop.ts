import z from "zod"
import { AgendaSessionWakeup } from "../agenda/session-wakeup"
import { BlueprintLoopStore, LoopError } from "../blueprint"
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

function stopResult(
  loop: Awaited<ReturnType<typeof BlueprintLoopStore.get>>,
  input: {
    code:
      | "BLUEPRINT_LOOP_REVIEW_QUEUED"
      | "BLUEPRINT_LOOP_REVIEW_ALREADY_QUEUED"
      | "BLUEPRINT_LOOP_REVIEW_ALREADY_STARTED"
    duplicate: boolean
  },
) {
  const reviewStarted = Boolean(loop.auditSessionID)
  const scopeBoundary =
    loop.source === "lattice"
      ? "This BlueprintLoop owns exactly one current Lattice Step. Do not create, submit, or implement a future Lattice Pathway Step."
      : "Do not extend the completed Blueprint into adjacent or follow-up work that was not part of its reviewed scope."
  const instruction = reviewStarted
    ? "The independent reviewer is already running and will deliver its verdict directly. Do not call tools to inspect, poll, assist, or duplicate the review. End this assistant turn now."
    : "The independent reviewer is queued but cannot start until this assistant turn releases the execution session. Do not call another tool. End this assistant turn immediately so review can begin."

  return {
    title: input.duplicate ? "BlueprintLoop review already requested" : "BlueprintLoop review requested",
    output: JSON.stringify(
      {
        ok: true,
        code: input.code,
        duplicate: input.duplicate,
        loop: {
          id: loop.id,
          title: loop.title,
          source: loop.source,
          executionClosed: true,
        },
        review: {
          requested: true,
          started: reviewStarted,
          startsAfterAssistantTurn: !reviewStarted,
          delivery: "The reviewer delivers its verdict directly to this execution session.",
        },
        requiredAgentAction: {
          kind: "end_turn",
          instruction,
        },
        scopeBoundary,
        prohibitedActions: [
          "Do not call another tool after this result.",
          "Do not modify files or artifacts after requesting review.",
          "Do not inspect or poll reviewer status.",
          "Do not begin adjacent work or a later workflow step.",
        ],
      },
      null,
      2,
    ),
    metadata: {
      loopStopRequested: true,
      reviewRequested: true,
      reviewStarted,
      reviewTaskID: loop.auditTaskID,
      reviewSessionID: loop.auditSessionID,
      requiredAgentAction: "end_turn",
    },
  }
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

    if (loop.stopRequest) {
      return stopResult(loop, {
        code: loop.auditSessionID ? "BLUEPRINT_LOOP_REVIEW_ALREADY_STARTED" : "BLUEPRINT_LOOP_REVIEW_ALREADY_QUEUED",
        duplicate: true,
      })
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
    const updated = await BlueprintLoopStore.recordStopRequest(scopeID, loop.id, {
      summary,
      completed: params.completed,
      evidence: params.evidence,
      remaining: params.remaining,
      requestedAt: Date.now(),
      requesterSessionID: ctx.sessionID,
      requesterMessageID: ctx.messageID,
    })

    return stopResult(updated, { code: "BLUEPRINT_LOOP_REVIEW_QUEUED", duplicate: false })
  },
})
