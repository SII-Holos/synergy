import z from "zod"
import { LatticeError } from "../lattice/error"
import { LatticeMachine } from "../lattice/machine"
import { LatticeStore } from "../lattice/store"
import { LatticeTypes } from "../lattice/types"
import { ScopeContext } from "../scope/context"
import { ToolDiagnosticError } from "./diagnostic"
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
    futureSteps: z
      .array(StepInput)
      .min(1)
      .describe(
        "Complete ordered replacement for pathway_read.pathway.editableFuture. Never include history or current Steps.",
      ),
  })
  .strict()

function sentence(value: string): string {
  return value.length === 0 ? value : value[0]!.toUpperCase() + value.slice(1)
}

export const PathwayWriteTool = Tool.define("pathway_write", {
  description: DESCRIPTION,
  parameters,
  async execute(params, ctx) {
    const scopeID = ScopeContext.current.scope.id
    const run = await LatticeStore.update(scopeID, ctx.sessionID, (current) =>
      LatticeMachine.writePathway(current, params.futureSteps),
    ).catch((error) => {
      if (error instanceof LatticeError.StateConflict) {
        throw new ToolDiagnosticError({
          code: "tool_unavailable",
          toolName: "pathway_write",
          message: `Pathway update rejected. ${sentence(error.data.reason)}. Call pathway_write only while the Run is planning or reviewing_pathway.`,
        })
      }
      if (!(error instanceof LatticeError.InvalidPathway)) throw error
      throw new ToolDiagnosticError({
        code: "invalid_arguments",
        toolName: "pathway_write",
        message: `Pathway update rejected. ${sentence(error.data.reason)}. Pass only the ordered pending Steps from pathway_read.pathway.editableFuture; omit history and current Steps.`,
      })
    })
    const view = LatticeTypes.toRunView(run)
    const completed = view.pathway.filter((step) => step.status === "completed").length
    const current =
      view.pathway.find((step) => step.id === view.currentStepID) ??
      view.pathway.find((step) => step.status === "current" || step.status === "executing") ??
      null
    const history = view.pathway.filter((step) => step.status !== "pending" && step.id !== current?.id)
    const editableFuture = view.pathway.filter((step) => step.status === "pending")

    return {
      title: `Pathway future updated (${editableFuture.length} Steps)`,
      output: JSON.stringify(
        {
          pathwayRevision: view.pathwayRevision,
          preserved: {
            historyStepCount: history.length,
            current,
          },
          editableFuture,
        },
        null,
        2,
      ),
      metadata: {
        runID: view.id,
        state: view.state,
        status: view.status,
        pathwayRevision: view.pathwayRevision,
        currentStepID: view.currentStepID,
        currentStepTitle: current?.title,
        completed,
        preservedStepCount: history.length + (current ? 1 : 0),
        editableFutureCount: editableFuture.length,
        total: view.pathway.length,
      },
    }
  },
})
