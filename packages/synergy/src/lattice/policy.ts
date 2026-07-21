import { Log } from "../util/log"
import type { ContinuationKernel } from "../session/continuation-kernel"
import { LatticeExecution } from "./execution"
import { LatticeMachine } from "./machine"
import { LatticeModelCalls } from "./model-calls"
import { LatticePrompt } from "./prompt"
import { LatticeStore } from "./store"
import { LatticeTypes } from "./types"

const log = Log.create({ service: "lattice.policy" })

export const LatticeContinuationPolicy: ContinuationKernel.Policy = {
  id: "lattice",
  priority: 50,
  async handle(gate) {
    if (gate.session.workflow?.kind !== "lattice") return undefined

    const run = await LatticeStore.getOrUndefined(gate.scopeID, gate.sessionID)
    if (!run || run.status !== "active") return undefined

    const count = (await LatticeModelCalls.flush(gate.scopeID, gate.sessionID)) ?? run.modelCallCount
    if (run.maxModelCalls > 0 && count >= run.maxModelCalls) {
      await LatticeMachine.markBudgetExhausted(gate.scopeID, gate.sessionID)
      return { kind: "handled" }
    }

    if (run.phase === "blueprint_review") return undefined

    if (run.phase === "blueprint_execution") {
      const result = await LatticeExecution.startCurrentStep(gate.scopeID, run)
      if (result.ok) return { kind: "handled" }
      if (result.reason === "already_active") return undefined
      log.warn("execution phase without a startable step", { sessionID: gate.sessionID, reason: result.reason })
    }

    return continuationProposal(run)
  },
}

function continuationProposal(run: LatticeTypes.Run): ContinuationKernel.InboxProposal {
  return {
    kind: "inbox",
    mode: "steer",
    message: {
      role: "user",
      summary: { title: "Continue Lattice pathway" },
      parts: [
        {
          type: "text",
          text: LatticePrompt.continuation(run),
          synthetic: true,
        },
      ],
      metadata: {
        source: "lattice_continuation",
        runID: run.id,
        phase: run.phase,
        stepID: run.currentStepID,
      },
    },
  }
}
