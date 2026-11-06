import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { z } from "zod"
import { BlueprintLoopStore, LoopError } from "../index"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionInvoke } from "@ericsanchezok/synergy-harness/session/invoke"
import { SessionLifecycle } from "@ericsanchezok/synergy-harness/session/lifecycle"
import DESCRIPTION from "./blueprint-loop-stop.txt"
import { Tool } from "@ericsanchezok/synergy-harness/tool/tool"
import { Lock } from "@ericsanchezok/synergy-harness/util/lock"
import { BlueprintLoopSources } from "../source"

export type BlueprintAgendaAssertClear = (input: {
  sessionID: string
  scopeID: string
  operation: "BlueprintLoop audit"
}) => Promise<void>

const runtimeState = RuntimeContext.state(() => ({
  agendaAssertClear: undefined as BlueprintAgendaAssertClear | undefined,
}))

export function setBlueprintAgendaAssertClear(fn: BlueprintAgendaAssertClear): void {
  const instanceState = runtimeState()

  RuntimeContext.assertCompositionOpen("Agenda review guard")
  if (instanceState.agendaAssertClear) throw new Error("Agenda review guard is already registered")
  instanceState.agendaAssertClear = fn
}

const parameters = z.object({
  action: z
    .enum(["request_review", "pause"])
    .optional()
    .describe("Request review (default), or pause an interactive execution until the user can resolve a blocker."),
  summary: z.string().describe("Results and evidence for review, or the blocker and user action needed to resume."),
})

interface StopMetadata {
  loopID: string
  requiredFeatures: string[]
  requiredAgentAction: string
  reviewRequested: boolean
  loopStopRequested?: boolean
  reviewStarted?: boolean
  reviewTaskID?: string
  reviewSessionID?: string
  pauseRequested?: boolean
}

function stopResult(loop: Awaited<ReturnType<typeof BlueprintLoopStore.get>>): Tool.ExecutionResult<StopMetadata> {
  const reviewStarted = loop.status === "auditing"
  return {
    title: "BlueprintLoop review requested",
    output:
      "End this turn now so independent review can proceed. Do not call tools, change artifacts or begin adjacent work; the reviewer delivers its verdict here.",
    metadata: {
      loopID: loop.id,
      requiredFeatures: BlueprintLoopSources.requiredFeatures(loop.source),
      loopStopRequested: true,
      reviewRequested: true,
      reviewStarted,
      reviewTaskID: loop.auditTaskID,
      reviewSessionID: reviewStarted ? loop.auditSessionID : undefined,
      requiredAgentAction: "end_turn",
    },
  }
}

export const BlueprintLoopStopTool = Tool.define<typeof parameters, StopMetadata>("blueprint_loop_stop", {
  description: DESCRIPTION,
  parameters,
  async execute(params, ctx) {
    using stop = await Lock.write(`blueprint-loop-stop:${ctx.sessionID}`)
    ctx.abort.throwIfAborted()
    const instanceState = runtimeState()

    const session = await Session.get(ctx.sessionID)
    const loopID = session.blueprint?.loopID
    if (!loopID || session.blueprint?.loopRole !== "execution") {
      throw new Error("Only the BlueprintLoop execution session may request review or pause")
    }

    const scopeID = ScopeContext.current.scope.id
    const loop = await BlueprintLoopStore.get(scopeID, loopID).catch(() => {
      throw new LoopError.NotFound({ id: loopID })
    })
    if (loop.sessionID !== ctx.sessionID) {
      throw new Error("Only the BlueprintLoop execution session may request review or pause")
    }

    if (params.action === "pause") {
      if (loop.stopRequest)
        throw new Error("Independent review is already requested; end this turn and await its verdict")
      if (loop.status !== "running")
        throw new Error(`Cannot pause BlueprintLoop ${loop.id} while its status is "${loop.status}"`)
      if (!SessionLifecycle.latchable(session))
        throw new Error(
          "Only an interactive, non-delegated execution can pause for user input. Report the blocker to the owning workflow instead; do not claim completion or retry this pause.",
        )
      const summary = params.summary.trim()
      if (!summary) throw new Error("summary is required")
      ctx.abort.throwIfAborted()
      await SessionLifecycle.pause({ sessionID: ctx.sessionID, reason: "workflow", description: summary })
      const paused = await SessionLifecycle.snapshot(ctx.sessionID)
      if (!paused) throw new Error("The execution could not be paused; inspect its current state before continuing")
      return {
        title: "BlueprintLoop execution paused",
        output: `Execution paused: ${paused.description ?? summary}\nThe Blueprint and progress remain available. Wait for explicit user input or Continue; do not request review or continue execution.`,
        metadata: {
          loopID: loop.id,
          requiredFeatures: BlueprintLoopSources.requiredFeatures(loop.source),
          pauseRequested: true,
          reviewRequested: false,
          requiredAgentAction: "end_turn",
        },
      }
    }

    if (loop.stopRequest) {
      return stopResult(loop)
    }
    if (loop.status !== "running") {
      throw new Error(`Cannot request review for BlueprintLoop ${loop.id} while its status is "${loop.status}"`)
    }
    if (await SessionLifecycle.snapshot(ctx.sessionID)) {
      throw new Error("Execution is paused; wait for explicit user input or Continue before requesting review")
    }

    const summary = params.summary.trim()
    if (!summary) throw new Error("summary is required")
    await instanceState.agendaAssertClear?.({
      sessionID: ctx.sessionID,
      scopeID,
      operation: "BlueprintLoop audit",
    })
    ctx.abort.throwIfAborted()
    const updated = await BlueprintLoopStore.recordStopRequest(scopeID, loop.id, {
      summary,
      requestedAt: Date.now(),
      requesterSessionID: ctx.sessionID,
      requesterMessageID: ctx.messageID,
    })

    return stopResult(updated)
  },
  afterPersist(params, ctx) {
    if (params.action !== "pause" || ctx.abort.aborted) return
    // Provenance: docs/postmortem/0083-blueprint-blockers-could-not-pause.md
    // Local adaptation: persist before signalling; never wait on a control lock held by input awaiting this lease.
    SessionInvoke.cancel(ctx.sessionID, { pauseTurn: true })
  },
})
