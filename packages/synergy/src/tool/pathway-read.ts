import z from "zod"
import { Tool } from "./tool"
import { ScopeContext } from "../scope/context"
import { LatticeStore } from "../lattice/store"
import { LatticeError } from "../lattice"
import DESCRIPTION from "./pathway-read.txt"

const parameters = z.object({})

export const PathwayReadTool = Tool.define("pathway_read", {
  description: DESCRIPTION,
  parameters,
  async execute(_params: z.infer<typeof parameters>, ctx) {
    const scopeID = ScopeContext.current.scope.id
    const run = await LatticeStore.getOrUndefined(scopeID, ctx.sessionID)
    if (!run) throw new LatticeError.NotFound({ sessionID: ctx.sessionID })

    const events = await LatticeStore.listEvents(scopeID, ctx.sessionID)
    const recent = events.slice(-8)

    const budget = run.maxModelCalls > 0 ? `${run.modelCallCount}/${run.maxModelCalls}` : `${run.modelCallCount}/unlimited`
    const lines: string[] = [
      `Lattice run ${run.id}`,
      `mode: ${run.mode}`,
      `phase: ${run.phase}`,
      `status: ${run.status}${run.statusReason ? ` (${run.statusReason})` : ""}`,
      `model calls: ${budget}`,
      run.goal ? `goal: ${run.goal}` : "",
      `current step: ${run.currentStepID ?? "none"}`,
      "",
      "Pathway:",
    ]
    run.pathway.forEach((step, index) => {
      const marker = step.id === run.currentStepID ? "→" : " "
      lines.push(`${marker} ${index + 1}. [${step.status}] ${step.title} (${step.id})`)
      lines.push(`     objective: ${step.objective}`)
      if (step.acceptanceCriteria.length) lines.push(`     acceptance: ${step.acceptanceCriteria.join("; ")}`)
      if (step.blueprintNoteID) lines.push(`     blueprint: ${step.blueprintNoteID}`)
      if (step.blueprintLoopID) lines.push(`     loop: ${step.blueprintLoopID}`)
      if (step.resultSummary) lines.push(`     result: ${step.resultSummary}`)
      if (step.failureReason) lines.push(`     failure: ${step.failureReason}`)
      if (step.addressesFailedStepIDs?.length)
        lines.push(`     addresses failed: ${step.addressesFailedStepIDs.join(", ")}`)
    })
    if (recent.length) {
      lines.push("", "Recent events:")
      for (const event of recent) lines.push(`- ${event.kind}${event.message ? `: ${event.message}` : ""}`)
    }

    return {
      title: `Lattice ${run.phase}`,
      output: lines.filter((line) => line !== "").join("\n"),
      metadata: {
        runID: run.id,
        phase: run.phase,
        status: run.status,
        mode: run.mode,
        currentStepID: run.currentStepID,
      } as Record<string, any>,
    }
  },
})
