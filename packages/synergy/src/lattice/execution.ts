import { BlueprintLoopStore, BlueprintLoopService } from "../blueprint"
import { LatticeMachine } from "./machine"
import { LatticeTypes } from "./types"

/**
 * Starts the BlueprintLoop for a Lattice run's current step. Shared by the
 * continuation policy (auto mode, at idle) and the /continue route
 * (collaborative mode). Advances the run to blueprint_execution before the
 * loop's first prompt is delivered so the woken turn sees the right phase.
 */
export namespace LatticeExecution {
  export type StartResult =
    | { ok: true; loopID: string }
    | { ok: false; reason: "no_current_step" | "not_bound" | "already_active" }

  export async function startCurrentStep(
    scopeID: string,
    run: LatticeTypes.Run,
    userPrompt?: string,
  ): Promise<StartResult> {
    const step = LatticeMachine.currentStep(run)
    if (!step) return { ok: false, reason: "no_current_step" }
    if (!step.blueprintNoteID) return { ok: false, reason: "not_bound" }

    // An active loop already bound to this step means execution is in flight.
    if (step.blueprintLoopID) {
      const existing = await BlueprintLoopStore.get(scopeID, step.blueprintLoopID).catch(() => undefined)
      if (existing && !isTerminalLoop(existing.status)) return { ok: false, reason: "already_active" }
    }

    const armed = await BlueprintLoopService.create({
      noteID: step.blueprintNoteID,
      noteVersion: step.blueprintVersion,
      title: step.title,
      description: step.objective,
      sessionID: run.sessionID,
      runMode: "current",
      orchestration: { kind: "lattice", runID: run.id },
    })
    // Reflect running state before the first prompt wakes the session.
    await LatticeMachine.onLoopStarted(scopeID, run.sessionID, step.id, armed.id)
    await BlueprintLoopService.start(scopeID, armed.id, userPrompt)
    return { ok: true, loopID: armed.id }
  }

  function isTerminalLoop(status: string): boolean {
    return status === "completed" || status === "failed" || status === "cancelled"
  }
}
