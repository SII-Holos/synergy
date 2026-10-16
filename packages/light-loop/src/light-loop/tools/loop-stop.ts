import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { z } from "zod"
import { Tool } from "@ericsanchezok/synergy-harness/tool/tool"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { LightLoopRuntime } from "../runtime"
import { LightLoopTerminalStore } from "../terminal-hook"
import DESCRIPTION from "./loop-stop.txt"

export type LightLoopAgendaAssertClear = (input: {
  sessionID: string
  scopeID: string
  operation: "Light Loop completion"
}) => Promise<void>

const runtimeState = RuntimeContext.state(() => ({
  agendaAssertClear: undefined as LightLoopAgendaAssertClear | undefined,
}))

export function setLightLoopAgendaAssertClear(fn: LightLoopAgendaAssertClear): void {
  const instanceState = runtimeState()

  RuntimeContext.assertCompositionOpen("Agenda review guard")
  if (instanceState.agendaAssertClear) throw new Error("Agenda review guard is already registered")
  instanceState.agendaAssertClear = fn
}

const parameters = z.object({
  summary: z.string().describe("Completed results and concrete verification evidence, including relevant limitations."),
})

export const LoopStopTool = Tool.define("loop_stop", {
  description: DESCRIPTION,
  parameters,
  async execute(params, ctx) {
    if (!params.summary.trim()) throw new Error("summary is required")
    ctx.abort.throwIfAborted()
    const session = await Session.get(ctx.sessionID)
    if (session.workflow && session.workflow.kind !== "lightloop")
      throw new Error("No active Light Loop on this session")
    if (session.workflow?.kind === "lightloop") {
      await runtimeState().agendaAssertClear?.({
        sessionID: ctx.sessionID,
        scopeID: ScopeContext.current.scope.id,
        operation: "Light Loop completion",
      })
      ctx.abort.throwIfAborted()
      await LightLoopRuntime.setTerminalStatus(ctx.sessionID, "completed", undefined, session.workflow)
    }
    const terminal = await LightLoopTerminalStore.get(session)
    if (terminal?.status !== "completed" || (await Session.get(ctx.sessionID)).workflow) {
      throw new Error("No active Light Loop to complete, or its goal changed during completion")
    }
    return {
      title: "Light Loop completed",
      output: "Light Loop completed. Summarize the verified result for the user.",
      metadata: { loopCompleted: true },
    }
  },
})
