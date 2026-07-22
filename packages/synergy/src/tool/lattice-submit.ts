import { LatticeAction } from "../lattice/action"
import { LatticeActionService } from "../lattice/action-service"
import { LatticeTypes } from "../lattice/types"
import { ScopeContext } from "../scope/context"
import DESCRIPTION from "./lattice-submit.txt"
import { Tool } from "./tool"

export const LatticeSubmitTool = Tool.define("lattice_submit", {
  description: DESCRIPTION,
  parameters: LatticeAction.ToolInput,
  async execute(params, ctx) {
    const input = LatticeAction.parseToolInput(params)
    const run = await LatticeActionService.submit({
      scopeID: ScopeContext.current.scope.id,
      sessionID: ctx.sessionID,
      source: "agent",
      input,
    })
    const view = LatticeTypes.toRunView(run)

    return {
      title: `Lattice action submitted: ${input.action}`,
      output: JSON.stringify(view, null, 2),
      metadata: {
        runID: view.id,
        state: view.state,
        status: view.status,
        action: input.action,
        source: "agent",
      },
    }
  },
})
