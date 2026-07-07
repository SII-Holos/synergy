import z from "zod"
import { Tool } from "./tool"
import { ScopeContext } from "../scope/context"
import { LatticeMachine } from "../lattice/machine"
import { LatticeStore } from "../lattice/store"
import { LatticeError } from "../lattice"
import DESCRIPTION from "./pathway-patch.txt"

const StepInput = z.object({
  id: z.string().optional().describe("Existing non-terminal step id to update; omit to create a new step."),
  title: z.string().describe("Short step title."),
  objective: z.string().describe("What this step must accomplish."),
  acceptanceCriteria: z.array(z.string()).optional().describe("How to judge this step is done."),
  assumptions: z.array(z.string()).optional(),
  addressesFailedStepIDs: z
    .array(z.string())
    .optional()
    .describe("For a recovery step: the failed step id(s) this step replaces."),
})

const parameters = z.object({
  steps: z
    .array(StepInput)
    .optional()
    .describe("Replace the ordered list of non-terminal steps. Terminal steps are preserved."),
  bindCurrentBlueprint: z
    .object({
      noteID: z.string().describe("Blueprint note id to bind to the current step."),
      version: z.number().optional(),
    })
    .optional(),
  recordResult: z
    .object({
      stepID: z.string(),
      resultSummary: z.string().optional(),
    })
    .optional()
    .describe("Attach a result summary to a terminal step (result_analysis)."),
})

export const PathwayPatchTool = Tool.define("pathway_patch", {
  description: DESCRIPTION,
  parameters,
  async execute(params: z.infer<typeof parameters>, ctx) {
    const scopeID = ScopeContext.current.scope.id
    const existing = await LatticeStore.getOrUndefined(scopeID, ctx.sessionID)
    if (!existing) throw new LatticeError.NotFound({ sessionID: ctx.sessionID })

    if (!params.steps && !params.bindCurrentBlueprint && !params.recordResult) {
      throw new Error("pathway_patch requires at least one of: steps, bindCurrentBlueprint, recordResult.")
    }

    const run = await LatticeMachine.patch(scopeID, ctx.sessionID, {
      steps: params.steps,
      bindCurrentBlueprint: params.bindCurrentBlueprint,
      recordResult: params.recordResult,
    })

    const summary = run.pathway
      .map((step, index) => {
        const marker = step.id === run.currentStepID ? "→" : " "
        return `${marker} ${index + 1}. [${step.status}] ${step.title}`
      })
      .join("\n")

    return {
      title: `Pathway updated → ${run.phase}`,
      output: [`Phase: ${run.phase}`, `Current step: ${run.currentStepID ?? "none"}`, "", summary].join("\n"),
      metadata: {
        runID: run.id,
        phase: run.phase,
        status: run.status,
        currentStepID: run.currentStepID,
        stepCount: run.pathway.length,
      } as Record<string, any>,
    }
  },
})
