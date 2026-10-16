import { ContinuationKernel } from "@ericsanchezok/synergy-harness/session/continuation-kernel"
import { isActiveLightLoopWorkflow } from "../session/light-loop-state"

export const LightLoopContinuationPolicy: ContinuationKernel.Policy = {
  id: "light_loop",
  priority: 25,
  async handle(gate) {
    if (!isActiveLightLoopWorkflow(gate.session.workflow)) return undefined
    return {
      kind: "inbox",
      mode: "steer",
      message: {
        role: "user",
        summary: { title: "Continue light loop" },
        origin: { type: "system" },
        parts: [
          {
            type: "text",
            text: "Continue toward the full Light Loop goal in the workflow context. If all required results are complete and verified, call loop_stop({summary}) with evidence. Otherwise finish the remaining work.",
            origin: "system",
          },
        ],
        metadata: { source: "light_loop_continuation", requiredOwners: ["light-loop"] },
      },
    }
  },
}
