import { Identifier } from "../id/id"
import { LatticeError } from "./error"
import { LatticeStore } from "./store"
import { LatticeTypes } from "./types"

/**
 * LatticeMachine owns every mutation of a Lattice run's phase and Pathway.
 * Agent-facing tools only submit patch intents; phase transitions are computed
 * here and by the bridge from deterministic events. Terminal steps are
 * immutable; the running step is frozen during blueprint_execution.
 */
export namespace LatticeMachine {
  export type StepInput = {
    id?: string
    title: string
    objective: string
    acceptanceCriteria?: string[]
    assumptions?: string[]
    addressesFailedStepIDs?: string[]
  }

  export type PatchInput = {
    /** Replace the ordered list of non-terminal steps (terminal steps preserved). */
    steps?: StepInput[]
    /** Bind the current step's Blueprint note (step_blueprinting). */
    bindCurrentBlueprint?: { noteID: string; version?: number }
    /** Record a result summary on a terminal step (result_analysis). */
    recordResult?: { stepID: string; resultSummary?: string }
  }

  function firstSelectableIndex(pathway: LatticeTypes.Step[]): number {
    return pathway.findIndex((step) => step.status === "pending" || step.status === "ready")
  }

  function findStep(run: LatticeTypes.Run, stepID: string | undefined): LatticeTypes.Step | undefined {
    if (!stepID) return undefined
    return run.pathway.find((step) => step.id === stepID)
  }

  /**
   * Apply an agent pathway patch and run the resulting automatic transition.
   * All validation (terminal immutability, running-step freeze, ordering) is
   * enforced here.
   */
  export async function patch(scopeID: string, sessionID: string, input: PatchInput): Promise<LatticeTypes.Run> {
    const run = await LatticeStore.get(scopeID, sessionID)
    if (run.status !== "active") {
      throw new LatticeError.PhaseViolation({ phase: run.phase, reason: `run is ${run.status}, not active` })
    }

    let boundBlueprint = false

    const next = await LatticeStore.update(scopeID, sessionID, (draft) => {
      if (input.steps) applyStepsReplacement(draft, input.steps)

      if (input.bindCurrentBlueprint) {
        const current = findStep(draft, draft.currentStepID)
        if (!current) {
          throw new LatticeError.PhaseViolation({
            phase: draft.phase,
            reason: "no current step to bind a Blueprint to",
          })
        }
        if (LatticeTypes.isTerminalStep(current.status)) {
          throw new LatticeError.InvalidPathway({ reason: "cannot bind a Blueprint to a terminal step" })
        }
        current.blueprintNoteID = input.bindCurrentBlueprint.noteID
        current.blueprintVersion = input.bindCurrentBlueprint.version
        current.time.updated = Date.now()
        boundBlueprint = true
      }

      if (input.recordResult) {
        const step = findStep(draft, input.recordResult.stepID)
        if (!step) {
          throw new LatticeError.InvalidPathway({ reason: `unknown step ${input.recordResult.stepID}` })
        }
        if (!LatticeTypes.isTerminalStep(step.status)) {
          throw new LatticeError.InvalidPathway({ reason: "recordResult only applies to a terminal step" })
        }
        if (input.recordResult.resultSummary !== undefined) step.resultSummary = input.recordResult.resultSummary
        step.time.updated = Date.now()
      }

      autoTransition(draft, { boundBlueprint })
    })

    await LatticeStore.appendEvent(scopeID, next, {
      kind: boundBlueprint ? "step_blueprint_bound" : "step_updated",
      stepID: next.currentStepID,
      phase: next.phase,
    })
    return next
  }

  /**
   * Replace the ordered non-terminal steps with `inputs`. Terminal steps keep
   * their identity and order (they are historically first in a sequential
   * pathway). A running step may not be dropped or have its objective changed.
   */
  function applyStepsReplacement(draft: LatticeTypes.Run, inputs: StepInput[]): void {
    if (draft.phase === "blueprint_execution") {
      throw new LatticeError.PhaseViolation({
        phase: draft.phase,
        reason: "the Pathway cannot be restructured while a step is executing",
      })
    }

    const terminal = draft.pathway.filter((step) => LatticeTypes.isTerminalStep(step.status))
    const terminalIDs = new Set(terminal.map((step) => step.id))
    const existingByID = new Map(draft.pathway.map((step) => [step.id, step]))

    const seen = new Set<string>()
    const now = Date.now()
    const resolved: LatticeTypes.Step[] = inputs.map((item) => {
      if (item.id) {
        if (terminalIDs.has(item.id)) {
          throw new LatticeError.InvalidPathway({ reason: `cannot modify terminal step ${item.id}` })
        }
        if (seen.has(item.id)) {
          throw new LatticeError.InvalidPathway({ reason: `duplicate step id ${item.id}` })
        }
        seen.add(item.id)
        const prior = existingByID.get(item.id)
        if (!prior) {
          throw new LatticeError.InvalidPathway({ reason: `unknown step id ${item.id}` })
        }
        if (prior.status === "running" && prior.objective !== item.objective) {
          throw new LatticeError.InvalidPathway({
            reason: `cannot change the objective of the running step ${item.id}`,
          })
        }
        return {
          ...prior,
          title: item.title,
          objective: item.objective,
          acceptanceCriteria: item.acceptanceCriteria ?? prior.acceptanceCriteria,
          assumptions: item.assumptions ?? prior.assumptions,
          addressesFailedStepIDs: item.addressesFailedStepIDs ?? prior.addressesFailedStepIDs,
          time: { ...prior.time, updated: now },
        }
      }
      return LatticeTypes.Step.parse({
        id: Identifier.ascending("lattice_step"),
        title: item.title,
        objective: item.objective,
        status: "pending",
        acceptanceCriteria: item.acceptanceCriteria ?? [],
        assumptions: item.assumptions ?? [],
        addressesFailedStepIDs: item.addressesFailedStepIDs,
        time: { created: now, updated: now },
      })
    })

    // A running step must be preserved by id.
    const runningStep = draft.pathway.find((step) => step.status === "running")
    if (runningStep && !seen.has(runningStep.id)) {
      throw new LatticeError.InvalidPathway({ reason: `the running step ${runningStep.id} cannot be dropped` })
    }

    draft.pathway = [...terminal, ...resolved]

    // If the current step was dropped, clear it so autoTransition reselects.
    if (draft.currentStepID && !draft.pathway.some((step) => step.id === draft.currentStepID)) {
      draft.currentStepID = undefined
    }
  }

  /** Compute the automatic phase transition after a mutation. */
  function autoTransition(draft: LatticeTypes.Run, ctx: { boundBlueprint: boolean }): void {
    if (draft.phase === "initial_planning") {
      const index = firstSelectableIndex(draft.pathway)
      if (index >= 0) {
        const step = draft.pathway[index]
        step.status = "ready"
        step.time.updated = Date.now()
        draft.currentStepID = step.id
        setPhase(draft, "step_blueprinting")
      }
      return
    }

    if (draft.phase === "step_blueprinting" && ctx.boundBlueprint) {
      const current = findStep(draft, draft.currentStepID)
      if (current?.blueprintNoteID) {
        if (draft.mode === "collaborative") {
          current.status = "reviewing"
          setPhase(draft, "blueprint_review")
        } else {
          // auto: the loop is started by the continuation policy at idle.
          setPhase(draft, "blueprint_execution")
        }
      }
      return
    }

    if (draft.phase === "result_analysis") {
      advanceAfterResult(draft)
      return
    }
  }

  /** Pick the next selectable step or complete the run. */
  function advanceAfterResult(draft: LatticeTypes.Run): void {
    const index = firstSelectableIndex(draft.pathway)
    if (index >= 0) {
      const step = draft.pathway[index]
      step.status = "ready"
      step.time.updated = Date.now()
      draft.currentStepID = step.id
      setPhase(draft, "step_blueprinting")
      return
    }
    // No more selectable steps — the run is done.
    draft.currentStepID = undefined
    draft.status = "completed"
    draft.statusReason = undefined
    draft.time.completed = Date.now()
  }

  function setPhase(draft: LatticeTypes.Run, phase: LatticeTypes.Phase): void {
    draft.phase = phase
  }

  // --- Bridge-driven transitions (deterministic loop events) ---

  export async function onLoopStarted(
    scopeID: string,
    sessionID: string,
    stepID: string,
    loopID: string,
  ): Promise<LatticeTypes.Run> {
    const wasFirst = !(await LatticeStore.getOrUndefined(scopeID, sessionID))?.firstBlueprintStarted
    const run = await LatticeStore.update(scopeID, sessionID, (draft) => {
      const step = findStep(draft, stepID)
      if (!step) return
      step.status = "running"
      step.blueprintLoopID = loopID
      step.time.started = Date.now()
      step.time.updated = Date.now()
      draft.currentStepID = step.id
      draft.firstBlueprintStarted = true
      setPhase(draft, "blueprint_execution")
    })
    // Mirror the monotonic first-blueprint flag onto the session so tool gating
    // (auto mode hides `question` after the first loop) can decide synchronously.
    if (wasFirst) {
      const { Session } = await import("../session")
      await Session.update(sessionID, (draft) => {
        if (draft.workflow?.kind === "lattice") {
          draft.workflow = { ...draft.workflow, firstBlueprintStarted: true }
        }
      }).catch(() => undefined)
    }
    await LatticeStore.appendEvent(scopeID, run, { kind: "step_started", stepID, phase: run.phase })
    return run
  }

  export async function onLoopCompleted(
    scopeID: string,
    sessionID: string,
    loopID: string,
    summary?: string,
  ): Promise<LatticeTypes.Run | undefined> {
    const before = await LatticeStore.getOrUndefined(scopeID, sessionID)
    if (!before) return undefined
    const step = before.pathway.find((s) => s.blueprintLoopID === loopID)
    if (!step || LatticeTypes.isTerminalStep(step.status)) return before
    const run = await LatticeStore.update(scopeID, sessionID, (draft) => {
      const target = findStep(draft, step.id)
      if (!target) return
      target.status = "completed"
      if (summary) target.resultSummary = summary
      target.time.completed = Date.now()
      target.time.updated = Date.now()
      setPhase(draft, "result_analysis")
    })
    await LatticeStore.appendEvent(scopeID, run, { kind: "step_completed", stepID: step.id, phase: run.phase })
    return run
  }

  export async function onLoopFailed(
    scopeID: string,
    sessionID: string,
    loopID: string,
    reason?: string,
  ): Promise<LatticeTypes.Run | undefined> {
    const before = await LatticeStore.getOrUndefined(scopeID, sessionID)
    if (!before) return undefined
    const step = before.pathway.find((s) => s.blueprintLoopID === loopID)
    if (!step || LatticeTypes.isTerminalStep(step.status)) return before
    const run = await LatticeStore.update(scopeID, sessionID, (draft) => {
      const target = findStep(draft, step.id)
      if (!target) return
      target.status = "failed"
      if (reason) target.failureReason = reason
      target.time.completed = Date.now()
      target.time.updated = Date.now()
      setPhase(draft, "result_analysis")
    })
    await LatticeStore.appendEvent(scopeID, run, { kind: "step_failed", stepID: step.id, phase: run.phase })
    return run
  }

  /** A loop was cancelled from the UI without exiting Lattice: revert the step and pause the run. */
  export async function onLoopCancelled(
    scopeID: string,
    sessionID: string,
    loopID: string,
  ): Promise<LatticeTypes.Run | undefined> {
    const before = await LatticeStore.getOrUndefined(scopeID, sessionID)
    if (!before) return undefined
    const step = before.pathway.find((s) => s.blueprintLoopID === loopID)
    if (!step || LatticeTypes.isTerminalStep(step.status)) return before
    const run = await LatticeStore.update(scopeID, sessionID, (draft) => {
      const target = findStep(draft, step.id)
      if (target && !LatticeTypes.isTerminalStep(target.status)) {
        target.status = "ready"
        target.blueprintLoopID = undefined
        target.time.updated = Date.now()
      }
      draft.status = "paused"
      draft.statusReason = "blueprint_loop_cancelled"
      draft.time.paused = Date.now()
    })
    await LatticeStore.appendEvent(scopeID, run, {
      kind: "loop_cancelled",
      stepID: step.id,
      data: { loopID },
    })
    await LatticeStore.appendEvent(scopeID, run, { kind: "run_paused", message: "blueprint_loop_cancelled" })
    return run
  }

  // --- Run lifecycle ---

  export async function pause(scopeID: string, sessionID: string, reason: string): Promise<LatticeTypes.Run> {
    const run = await LatticeStore.update(scopeID, sessionID, (draft) => {
      const running = draft.pathway.find((step) => step.status === "running")
      if (running) {
        running.status = "ready"
        running.blueprintLoopID = undefined
        running.time.updated = Date.now()
      }
      draft.status = "paused"
      draft.statusReason = reason
      draft.time.paused = Date.now()
    })
    await LatticeStore.appendEvent(scopeID, run, { kind: "run_paused", message: reason })
    return run
  }

  export async function cancel(scopeID: string, sessionID: string): Promise<LatticeTypes.Run> {
    const run = await LatticeStore.update(scopeID, sessionID, (draft) => {
      draft.status = "cancelled"
      draft.time.completed = Date.now()
    })
    await LatticeStore.appendEvent(scopeID, run, { kind: "run_cancelled" })
    return run
  }

  export async function fail(scopeID: string, sessionID: string, reason: string): Promise<LatticeTypes.Run> {
    const run = await LatticeStore.update(scopeID, sessionID, (draft) => {
      draft.status = "failed"
      draft.statusReason = reason
      draft.time.completed = Date.now()
    })
    await LatticeStore.appendEvent(scopeID, run, { kind: "run_failed", message: reason })
    return run
  }

  /** Recompute the phase when resuming a paused run. */
  export async function resume(scopeID: string, sessionID: string): Promise<LatticeTypes.Run> {
    const run = await LatticeStore.update(scopeID, sessionID, (draft) => {
      draft.status = "active"
      draft.statusReason = undefined
      draft.time.paused = undefined
      const current = findStep(draft, draft.currentStepID)
      if (current && !LatticeTypes.isTerminalStep(current.status)) {
        if (current.blueprintNoteID) {
          if (draft.mode === "collaborative") {
            current.status = "reviewing"
            setPhase(draft, "blueprint_review")
          } else {
            current.status = "ready"
            setPhase(draft, "blueprint_execution")
          }
        } else {
          current.status = "ready"
          setPhase(draft, "step_blueprinting")
        }
        return
      }
      const index = firstSelectableIndex(draft.pathway)
      if (index >= 0) {
        const step = draft.pathway[index]
        step.status = "ready"
        draft.currentStepID = step.id
        setPhase(draft, "step_blueprinting")
      } else {
        draft.currentStepID = undefined
        setPhase(draft, "initial_planning")
      }
    })
    await LatticeStore.appendEvent(scopeID, run, { kind: "run_resumed", phase: run.phase })
    return run
  }

  /** Mark the run paused because the model-call budget is exhausted. */
  export async function markBudgetExhausted(scopeID: string, sessionID: string): Promise<LatticeTypes.Run> {
    const run = await LatticeStore.update(scopeID, sessionID, (draft) => {
      draft.status = "paused"
      draft.statusReason = "model_call_budget_exhausted"
      draft.time.paused = Date.now()
    })
    await LatticeStore.appendEvent(scopeID, run, { kind: "budget_exhausted" })
    return run
  }

  export function currentStep(run: LatticeTypes.Run): LatticeTypes.Step | undefined {
    return findStep(run, run.currentStepID)
  }
}
