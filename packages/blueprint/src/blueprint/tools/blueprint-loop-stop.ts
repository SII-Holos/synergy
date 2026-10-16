import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { z } from "zod"
import { BlueprintLoopStore, LoopError } from "../index"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import DESCRIPTION from "./blueprint-loop-stop.txt"
import { Tool } from "@ericsanchezok/synergy-harness/tool/tool"
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
  summary: z.string().describe("Delivered results, concrete verification evidence, and any remaining limitations."),
})

function stopResult(loop: Awaited<ReturnType<typeof BlueprintLoopStore.get>>) {
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

export const BlueprintLoopStopTool = Tool.define("blueprint_loop_stop", {
  description: DESCRIPTION,
  parameters,
  async execute(params, ctx) {
    ctx.abort.throwIfAborted()
    const instanceState = runtimeState()

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
      return stopResult(loop)
    }
    if (loop.status !== "running") {
      throw new Error(`Cannot request review for BlueprintLoop ${loop.id} while its status is "${loop.status}"`)
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
})
