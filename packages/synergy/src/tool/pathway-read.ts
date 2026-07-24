import z from "zod"
import { LatticeError } from "../lattice/error"
import { LatticeStore } from "../lattice/store"
import { LatticeTypes } from "../lattice/types"
import { ScopeContext } from "../scope/context"
import DESCRIPTION from "./pathway-read.txt"
import { Tool } from "./tool"

const parameters = z.object({}).strict()

export const PathwayReadTool = Tool.define("pathway_read", {
  description: DESCRIPTION,
  parameters,
  async execute(_params, ctx) {
    const scopeID = ScopeContext.current.scope.id
    const run = await LatticeStore.getOrUndefined(scopeID, ctx.sessionID)
    if (!run) throw new LatticeError.NotFound({ sessionID: ctx.sessionID })

    const view = LatticeTypes.toRunView(run)
    const completed = view.pathway.filter((step) => step.status === "completed").length
    const current =
      view.pathway.find((step) => step.id === view.currentStepID) ??
      view.pathway.find((step) => step.status === "current" || step.status === "executing") ??
      null
    const history = view.pathway.filter((step) => step.status !== "pending" && step.id !== current?.id)
    const editableFuture = view.pathway.filter((step) => step.status === "pending")
    const { pathway: _, ...runView } = view

    return {
      title: `Lattice ${view.state}`,
      output: JSON.stringify(
        {
          ...runView,
          pathway: {
            history,
            current,
            editableFuture,
          },
        },
        null,
        2,
      ),
      metadata: {
        runID: view.id,
        state: view.state,
        status: view.status,
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
