import { BlueprintLoopStore } from "../blueprint"
import { Identifier } from "../id/id"
import { ScopeContext } from "../scope/context"
import { Session } from "../session"
import { SessionManager } from "../session/manager"
import { ContinuationKernel } from "../session/continuation-kernel"
import { LatticeError } from "./error"
import { LatticeExecution } from "./execution"
import { LatticeMachine } from "./machine"
import { LatticeStore } from "./store"
import { LatticeTypes } from "./types"

/**
 * Orchestrates the session-facing Lattice lifecycle: enabling/pausing the mode,
 * keeping session metadata in sync, cancelling loops on exit, and the
 * collaborative Continue / cancel actions.
 */
export namespace LatticeRunService {
  export type EnableInput = {
    sessionID: string
    mode: LatticeTypes.Mode
    maxModelCalls?: number
    goal?: string
    action?: "continue" | "restart"
  }

  function activeLoopStatus(status: string): boolean {
    return status === "armed" || status === "running" || status === "waiting" || status === "auditing"
  }

  async function writeSessionLattice(run: LatticeTypes.Run): Promise<void> {
    await Session.update(run.sessionID, (draft) => {
      draft.lattice = {
        runID: run.id,
        mode: run.mode,
        firstBlueprintStarted: run.firstBlueprintStarted,
      }
      draft.blueprint = { ...draft.blueprint, planMode: false }
    })
  }

  async function clearSessionLattice(sessionID: string): Promise<void> {
    await Session.update(sessionID, (draft) => {
      draft.lattice = undefined
    })
  }

  async function assertNoForeignLoop(session: Session.Info): Promise<void> {
    const loopID = session.blueprint?.loopID
    if (!loopID) return
    const scopeID = ScopeContext.current.scope.id
    const loop = await BlueprintLoopStore.get(scopeID, loopID).catch(() => undefined)
    if (loop && activeLoopStatus(loop.status) && loop.orchestration?.kind !== "lattice") {
      throw new Error(`Session ${session.id} has an active BlueprintLoop; finish or cancel it before enabling Lattice.`)
    }
  }

  async function cancelActiveLatticeLoop(scopeID: string, session: Session.Info): Promise<void> {
    const loopID = session.blueprint?.loopID
    if (!loopID) return
    const loop = await BlueprintLoopStore.get(scopeID, loopID).catch(() => undefined)
    if (loop && activeLoopStatus(loop.status) && loop.orchestration?.kind === "lattice") {
      await BlueprintLoopStore.updateStatus(scopeID, loopID, { status: "cancelled" }).catch(() => undefined)
    }
  }

  async function deliverPlanningKick(sessionID: string, goal: string): Promise<void> {
    await SessionManager.deliver({
      target: sessionID,
      mail: {
        type: "user",
        summary: { title: "Start Lattice planning" },
        parts: [
          {
            id: Identifier.ascending("part"),
            sessionID,
            messageID: Identifier.ascending("message"),
            type: "text",
            text: `Begin this Lattice run. Goal:\n${goal}\n\nInvestigate as needed, then create the initial ordered Pathway with pathway_patch.`,
          },
        ],
        metadata: { source: "lattice_planning_kick", goal },
      },
      waitForProcessing: false,
    })
  }

  export async function enable(input: EnableInput): Promise<LatticeTypes.Run> {
    const scopeID = ScopeContext.current.scope.id
    const session = await Session.get(input.sessionID)
    if (session.scope.id !== scopeID) {
      throw new Error(`Session ${input.sessionID} is not in the current scope.`)
    }

    const existing = await LatticeStore.getOrUndefined(scopeID, input.sessionID)

    if (existing && existing.status === "active" && input.action !== "restart") {
      const run = await LatticeStore.update(scopeID, input.sessionID, (draft) => {
        draft.mode = input.mode
        if (input.maxModelCalls !== undefined) draft.maxModelCalls = input.maxModelCalls
      })
      await writeSessionLattice(run)
      return run
    }

    if (existing && existing.status === "paused" && input.action === "continue") {
      await LatticeStore.update(scopeID, input.sessionID, (draft) => {
        draft.mode = input.mode
        if (input.maxModelCalls !== undefined) draft.maxModelCalls = input.maxModelCalls
      })
      const run = await LatticeMachine.resume(scopeID, input.sessionID)
      await writeSessionLattice(run)
      // The session is idle; nudge the kernel so it starts a loop or continues.
      void ContinuationKernel.kick(input.sessionID).catch(() => undefined)
      return run
    }

    // New run, or an explicit restart / non-continuable prior data → reset.
    await assertNoForeignLoop(session)
    const run = await LatticeStore.reset({
      sessionID: input.sessionID,
      mode: input.mode,
      maxModelCalls: input.maxModelCalls,
      goal: input.goal,
    })
    await writeSessionLattice(run)
    if (input.goal) await deliverPlanningKick(input.sessionID, input.goal)
    return run
  }

  export async function disable(sessionID: string): Promise<LatticeTypes.Run | undefined> {
    const scopeID = ScopeContext.current.scope.id
    const run = await LatticeStore.getOrUndefined(scopeID, sessionID)
    if (run && run.status === "active") {
      // Pause first (run → paused) so the loop-cancel bridge stays inert, then
      // cancel the in-flight loop.
      const paused = await LatticeMachine.pause(scopeID, sessionID, "user_exit")
      const session = await Session.get(sessionID)
      await cancelActiveLatticeLoop(scopeID, session)
      await clearSessionLattice(sessionID)
      return paused
    }
    await clearSessionLattice(sessionID)
    return run
  }

  export async function continueReview(runID: string, userPrompt?: string): Promise<LatticeTypes.Run> {
    const scopeID = ScopeContext.current.scope.id
    const run = await LatticeStore.getByRunID(scopeID, runID)
    if (!run) throw new LatticeError.NotFound({ sessionID: runID })
    if (run.mode !== "collaborative" || run.phase !== "blueprint_review") {
      throw new LatticeError.PhaseViolation({
        phase: run.phase,
        reason: "Continue is only valid in collaborative blueprint_review",
      })
    }
    const result = await LatticeExecution.startCurrentStep(scopeID, run, userPrompt)
    if (!result.ok) {
      throw new LatticeError.PhaseViolation({ phase: run.phase, reason: `cannot start Blueprint: ${result.reason}` })
    }
    return await LatticeStore.get(scopeID, run.sessionID)
  }

  export async function cancel(runID: string): Promise<LatticeTypes.Run> {
    const scopeID = ScopeContext.current.scope.id
    const run = await LatticeStore.getByRunID(scopeID, runID)
    if (!run) throw new LatticeError.NotFound({ sessionID: runID })
    const cancelled = await LatticeMachine.cancel(scopeID, run.sessionID)
    const session = await Session.get(run.sessionID).catch(() => undefined)
    if (session) await cancelActiveLatticeLoop(scopeID, session)
    await clearSessionLattice(run.sessionID)
    return cancelled
  }
}
