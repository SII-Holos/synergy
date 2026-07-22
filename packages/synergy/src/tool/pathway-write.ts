import z from "zod"
import { LatticeMachine } from "../lattice/machine"
import { LatticeStore } from "../lattice/store"
import { LatticeTypes } from "../lattice/types"
import { ScopeContext } from "../scope/context"
import DESCRIPTION from "./pathway-write.txt"
import { Tool } from "./tool"

const StepInput = z
  .object({
    id: z.string().optional().describe("Existing pending Step id to retain and revise; omit to create a new Step."),
    title: z.string().trim().min(1).describe("Short Step title."),
    objective: z.string().trim().min(1).describe("What the Step must accomplish."),
    acceptanceCriteria: z.array(z.string().trim().min(1)).optional().describe("How to judge the Step complete."),
    assumptions: z.array(z.string().trim().min(1)).optional(),
    addressesFailedStepIDs: z
      .array(z.string().min(1))
      .optional()
      .describe("Failed Step ids this recovery Step explicitly addresses."),
  })
  .strict()

const parameters = z
  .object({
    steps: z
      .array(StepInput)
      .min(1)
      .describe(
        "Complete ordered replacement for all pending future Steps; historical and current Steps are preserved.",
      ),
  })
  .strict()

export const PathwayWriteTool = Tool.define("pathway_write", {
  description: DESCRIPTION,
  parameters,
  async execute(params, ctx) {
    const scopeID = ScopeContext.current.scope.id
    const run = await LatticeStore.update(scopeID, ctx.sessionID, (current) =>
      LatticeMachine.writePathway(current, params.steps),
    )
    const view = LatticeTypes.toRunView(run)
    const completed = view.pathway.filter((step) => step.status === "completed").length
    const currentStep = view.pathway.find((step) => step.id === view.currentStepID)

    return {
      title: `Pathway written (${view.pathway.length} Steps)`,
      output: JSON.stringify(view, null, 2),
      metadata: {
        runID: view.id,
        state: view.state,
        status: view.status,
        pathwayRevision: view.pathwayRevision,
        currentStepID: view.currentStepID,
        currentStepTitle: currentStep?.title,
        completed,
        total: view.pathway.length,
      },
    }
  },
})
