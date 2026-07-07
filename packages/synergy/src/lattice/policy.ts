import { Identifier } from "../id/id"
import { Log } from "../util/log"
import type { ContinuationKernel } from "../session/continuation-kernel"
import { SessionManager } from "../session/manager"
import { LatticeExecution } from "./execution"
import { LatticeMachine } from "./machine"
import { LatticeModelCalls } from "./model-calls"
import { LatticePrompt } from "./prompt"
import { LatticeStore } from "./store"
import { LatticeTypes } from "./types"

const log = Log.create({ service: "lattice.policy" })

/**
 * LatticeContinuationPolicy drives an active Lattice run forward when its
 * session goes idle. Registered with the ContinuationKernel below the
 * BlueprintLoop policy, so a live loop owns the idle while it is running.
 *
 * Responsibilities per idle:
 *  - flush model-call accounting and pause the run if the budget is exhausted;
 *  - in blueprint_execution, start the next step's BlueprintLoop (auto mode);
 *  - in other active phases, deliver a continuation prompt to keep going;
 *  - never continue during collaborative blueprint_review.
 */
export const LatticeContinuationPolicy: ContinuationKernel.Policy = {
  id: "lattice",
  priority: 50,
  async handle(gate) {
    const lattice = gate.session.lattice
    if (!lattice) return false

    const run = await LatticeStore.getOrUndefined(gate.scopeID, gate.sessionID)
    if (!run || run.status !== "active") return false

    // Flush accumulated model calls, then enforce the budget.
    const count = (await LatticeModelCalls.flush(gate.scopeID, gate.sessionID)) ?? run.modelCallCount
    if (run.maxModelCalls > 0 && count >= run.maxModelCalls) {
      await LatticeMachine.markBudgetExhausted(gate.scopeID, gate.sessionID)
      return true
    }

    if (run.phase === "blueprint_review") return false

    if (run.phase === "blueprint_execution") {
      const result = await LatticeExecution.startCurrentStep(gate.scopeID, run)
      if (result.ok) return true
      if (result.reason === "already_active") return false
      // Not bound / no current step in execution phase is anomalous; fall through
      // to a continuation prompt so the agent can recover.
      log.warn("execution phase without a startable step", { sessionID: gate.sessionID, reason: result.reason })
    }

    // initial_planning / step_blueprinting / result_analysis (and recovery):
    // wake the session to keep advancing the current phase.
    await deliverContinuation(gate.sessionID, run)
    return true
  },
}

async function deliverContinuation(sessionID: string, run: LatticeTypes.Run): Promise<void> {
  await SessionManager.deliver({
    target: sessionID,
    mail: {
      type: "user",
      summary: { title: "Continue Lattice pathway" },
      parts: [
        {
          id: Identifier.ascending("part"),
          sessionID,
          messageID: "",
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
  })
}
