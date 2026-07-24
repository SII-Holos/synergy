import { Identifier } from "../id/id"
import { LatticeError } from "./error"
import { LatticeTypes } from "./types"

/**
 * Pure Lattice state transitions. This module performs no storage, Session,
 * Inbox, Bus, or BlueprintLoop I/O; callers persist the returned strict v2 Run.
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

  export type LoopTerminalInput = {
    loopID: string
    status: "completed" | "failed" | "cancelled"
    summary?: string
    error?: string
  }

  function edit(run: LatticeTypes.Run, editor: (draft: LatticeTypes.Run) => void): LatticeTypes.Run {
    const draft = structuredClone(run)
    editor(draft)
    return LatticeTypes.Run.parse(draft)
  }

  function stateConflict(run: LatticeTypes.Run, reason: string): never {
    throw new LatticeError.StateConflict({ state: run.state, reason })
  }

  function assertActive(run: LatticeTypes.Run): void {
    if (run.status !== "active") stateConflict(run, `run is ${run.status}, not active`)
  }

  function assertState(run: LatticeTypes.Run, state: LatticeTypes.State): void {
    if (run.state !== state) stateConflict(run, `expected ${state}, got ${run.state}`)
  }

  function advanceStateRevision(draft: LatticeTypes.Run, now: number): void {
    draft.stateRevision++
    draft.time.updated = now
  }

  function setState(draft: LatticeTypes.Run, state: LatticeTypes.State): void {
    draft.state = state
  }

  function findStep(run: LatticeTypes.Run, stepID: string | undefined): LatticeTypes.Step | undefined {
    if (!stepID) return undefined
    return run.pathway.find((step) => step.id === stepID)
  }

  function requireCurrentStep(run: LatticeTypes.Run): LatticeTypes.Step {
    const step = findStep(run, run.currentStepID)
    if (!step) stateConflict(run, "the run has no current Step")
    return step
  }

  function firstPendingStep(run: LatticeTypes.Run): LatticeTypes.Step | undefined {
    return run.pathway.find((step) => step.status === "pending")
  }

  function requireNoEffect(run: LatticeTypes.Run): void {
    if (run.effect) stateConflict(run, `effect ${run.effect.id} is still pending`)
  }

  export function currentStep(run: LatticeTypes.Run): LatticeTypes.Step | undefined {
    return findStep(run, run.currentStepID)
  }

  /** Replace only future pending Steps; historical/current Steps remain immutable and ordered. */
  export function writePathway(run: LatticeTypes.Run, inputs: StepInput[], now = Date.now()): LatticeTypes.Run {
    assertActive(run)
    if (run.state !== "planning" && run.state !== "reviewing_pathway") {
      stateConflict(run, "the Pathway can only be written while planning or reviewing it")
    }

    return edit(run, (draft) => {
      const history = draft.pathway.filter((step) => step.status !== "pending")
      const historicalIDs = new Set(history.map((step) => step.id))
      const pendingByID = new Map(
        draft.pathway.filter((step) => step.status === "pending").map((step) => [step.id, step]),
      )
      const failedIDs = new Set(draft.pathway.filter((step) => step.status === "failed").map((step) => step.id))
      const seen = new Set<string>()

      const future = inputs.map((input) => {
        const title = input.title.trim()
        const objective = input.objective.trim()
        if (!title || !objective) {
          throw new LatticeError.InvalidPathway({ reason: "Step title and objective must be non-empty" })
        }
        if (input.id && historicalIDs.has(input.id)) {
          throw new LatticeError.InvalidPathway({ reason: `cannot rewrite historical Step ${input.id}` })
        }
        if (input.id && seen.has(input.id)) {
          throw new LatticeError.InvalidPathway({ reason: `duplicate Step id ${input.id}` })
        }
        if (input.addressesFailedStepIDs?.some((stepID) => !failedIDs.has(stepID))) {
          throw new LatticeError.InvalidPathway({ reason: "addressesFailedStepIDs must reference failed Steps" })
        }
        if (input.id) seen.add(input.id)

        const prior = input.id ? pendingByID.get(input.id) : undefined
        if (input.id && !prior) {
          throw new LatticeError.InvalidPathway({ reason: `unknown pending Step ${input.id}` })
        }
        return LatticeTypes.Step.parse({
          ...(prior ?? {
            id: Identifier.ascending("lattice_step"),
            status: "pending",
            blueprintHistory: [],
            loopHistory: [],
            time: { created: now, updated: now },
          }),
          title,
          objective,
          acceptanceCriteria: input.acceptanceCriteria ?? prior?.acceptanceCriteria ?? [],
          assumptions: input.assumptions ?? prior?.assumptions ?? [],
          addressesFailedStepIDs: input.addressesFailedStepIDs ?? prior?.addressesFailedStepIDs,
          time: { ...(prior?.time ?? { created: now }), updated: now },
        })
      })

      draft.pathway = [...history, ...future]
      draft.pathwayRevision++
      draft.time.updated = now
    })
  }

  /** Persist a semantic action without changing workflow state. */
  export function queueAction(
    run: LatticeTypes.Run,
    action: LatticeTypes.PendingAction,
    now = Date.now(),
  ): LatticeTypes.Run {
    assertActive(run)
    if (run.pendingAction) stateConflict(run, `action ${run.pendingAction.id} is already pending`)
    if (action.expectedStateRevision !== run.stateRevision) {
      stateConflict(run, `stale state revision ${action.expectedStateRevision}; current is ${run.stateRevision}`)
    }
    if (action.expectedPathwayRevision !== run.pathwayRevision) {
      stateConflict(run, `stale Pathway revision ${action.expectedPathwayRevision}; current is ${run.pathwayRevision}`)
    }
    return edit(run, (draft) => {
      draft.pendingAction = LatticeTypes.PendingAction.parse(action)
      draft.time.updated = now
    })
  }

  /** Consume exactly one persisted action and deterministically advance state. */
  export function consumePendingAction(run: LatticeTypes.Run, now = Date.now()): LatticeTypes.Run {
    assertActive(run)
    const action = run.pendingAction
    if (!action) stateConflict(run, "there is no pending action")
    if (action.expectedStateRevision !== run.stateRevision) {
      stateConflict(run, `stale state revision ${action.expectedStateRevision}; current is ${run.stateRevision}`)
    }
    if (action.expectedPathwayRevision !== run.pathwayRevision) {
      stateConflict(run, `stale Pathway revision ${action.expectedPathwayRevision}; current is ${run.pathwayRevision}`)
    }

    return edit(run, (draft) => {
      switch (action.kind) {
        case "submit_requirements": {
          assertState(draft, "clarifying")
          requireNoEffect(draft)
          draft.requirements = action.requirements
          setState(draft, "planning")
          break
        }
        case "submit_pathway": {
          assertState(draft, "planning")
          requireNoEffect(draft)
          if (!firstPendingStep(draft)) {
            throw new LatticeError.InvalidPathway({ reason: "the Pathway must contain at least one pending Step" })
          }
          setState(draft, "reviewing_pathway")
          break
        }
        case "submit_pathway_review": {
          assertState(draft, "reviewing_pathway")
          requireNoEffect(draft)
          const next = firstPendingStep(draft)
          if (!next) throw new LatticeError.InvalidPathway({ reason: "the Pathway has no pending Step" })
          next.status = "current"
          next.time.updated = now
          draft.currentStepID = next.id
          setState(draft, "blueprinting")
          break
        }
        case "submit_blueprint": {
          assertState(draft, "blueprinting")
          requireNoEffect(draft)
          const step = requireCurrentStep(draft)
          if (step.status !== "current") stateConflict(draft, `current Step is ${step.status}`)
          if (step.blueprint) step.blueprintHistory.push(step.blueprint)
          step.blueprint = {
            noteID: action.blueprintID,
            boundVersion: action.blueprintVersion,
            contentDigest: action.contentDigest,
            time: { bound: now },
          }
          step.time.updated = now
          setState(draft, "reviewing_blueprint")
          break
        }
        case "submit_blueprint_review": {
          assertState(draft, "reviewing_blueprint")
          requireNoEffect(draft)
          const step = requireCurrentStep(draft)
          const binding = step.blueprint
          if (!binding) stateConflict(draft, "the current Step has no Blueprint binding")
          binding.reviewedVersion = action.blueprintVersion
          binding.reviewedContentDigest = action.contentDigest
          binding.time.reviewed = now
          step.time.updated = now
          if (draft.mode === "auto") {
            setState(draft, "executing")
            draft.effect = createLoopEffect(step, binding, now)
          } else {
            setState(draft, "awaiting_execution")
          }
          break
        }
        case "approve_execution": {
          assertState(draft, "awaiting_execution")
          requireNoEffect(draft)
          const step = requireCurrentStep(draft)
          const binding = step.blueprint
          if (binding?.reviewedVersion === undefined || !binding.reviewedContentDigest) {
            stateConflict(draft, "the current Blueprint has not been reviewed")
          }
          if (
            binding.reviewedVersion !== action.blueprintVersion ||
            binding.reviewedContentDigest !== action.contentDigest
          ) {
            stateConflict(draft, "the Blueprint changed after review")
          }
          setState(draft, "executing")
          draft.effect = createLoopEffect(step, binding, now)
          break
        }
      }
      draft.pendingAction = undefined
      advanceStateRevision(draft, now)
    })
  }

  function createLoopEffect(
    step: LatticeTypes.Step,
    binding: LatticeTypes.BlueprintBinding,
    now: number,
  ): LatticeTypes.CreateBlueprintLoopEffect {
    const version = binding.reviewedVersion ?? binding.boundVersion
    const digest = binding.reviewedContentDigest ?? binding.contentDigest
    return {
      id: Identifier.ascending("lattice_effect"),
      kind: "create_blueprint_loop",
      stepID: step.id,
      blueprintNoteID: binding.noteID,
      blueprintVersion: version,
      sourceDigest: digest,
      time: { created: now },
    }
  }

  /** Return a changed approved Blueprint to self-review while retaining its prior binding in history. */
  export function invalidateBlueprintReview(
    run: LatticeTypes.Run,
    latest: { version: number; contentDigest: string },
    now = Date.now(),
  ): LatticeTypes.Run {
    assertActive(run)
    if (run.state !== "awaiting_execution" && run.state !== "reviewing_blueprint" && run.state !== "executing") {
      stateConflict(run, "Blueprint review can only be invalidated before execution")
    }
    return edit(run, (draft) => {
      const step = requireCurrentStep(draft)
      const binding = step.blueprint
      if (!binding) stateConflict(draft, "the current Step has no Blueprint binding")
      step.blueprintHistory.push(binding)
      step.blueprint = {
        noteID: binding.noteID,
        boundVersion: latest.version,
        contentDigest: latest.contentDigest,
        time: { bound: now },
      }
      for (const attempt of step.loopHistory) {
        if (attempt.status !== "created" && attempt.status !== "running") continue
        attempt.status = "cancelled"
        attempt.error = "Blueprint changed before execution handoff completed"
        attempt.time.completed = now
      }
      step.status = "current"
      step.time.completed = undefined
      step.time.updated = now
      draft.effect = undefined
      setState(draft, "reviewing_blueprint")
      advanceStateRevision(draft, now)
    })
  }

  /** Atomically hand off a created BlueprintLoop to the separate start effect. */
  export function onLoopCreated(
    run: LatticeTypes.Run,
    input: { loopID: string; blueprintVersion: number; sourceDigest: string },
    now = Date.now(),
  ): LatticeTypes.Run {
    assertActive(run)
    assertState(run, "executing")
    const effect = run.effect
    if (effect?.kind !== "create_blueprint_loop") stateConflict(run, "no create BlueprintLoop effect is pending")
    if (effect.sourceDigest !== input.sourceDigest) stateConflict(run, "created BlueprintLoop source digest differs")

    return edit(run, (draft) => {
      const step = findStep(draft, effect.stepID)
      if (!step) stateConflict(draft, `unknown effect Step ${effect.stepID}`)
      if (step.loopHistory.some((attempt) => attempt.loopID === input.loopID)) {
        stateConflict(draft, `BlueprintLoop ${input.loopID} is already recorded`)
      }
      step.status = "executing"
      step.loopHistory.push({
        loopID: Identifier.ascending("blueprint_loop", input.loopID),
        status: "created",
        sourceDigest: input.sourceDigest,
        time: { created: now },
      })
      step.time.started ??= now
      step.time.updated = now
      draft.effect = {
        id: Identifier.ascending("lattice_effect"),
        kind: "start_blueprint_loop",
        stepID: step.id,
        loopID: Identifier.ascending("blueprint_loop", input.loopID),
        blueprintVersion: input.blueprintVersion,
        sourceDigest: input.sourceDigest,
        time: { created: now },
      }
      advanceStateRevision(draft, now)
    })
  }

  export function onLoopStarted(run: LatticeTypes.Run, loopID: string, now = Date.now()): LatticeTypes.Run {
    assertActive(run)
    assertState(run, "executing")
    const existingStep = run.pathway.find((step) => step.loopHistory.some((attempt) => attempt.loopID === loopID))
    const existing = existingStep?.loopHistory.find((attempt) => attempt.loopID === loopID)
    if (existing?.status === "running" && run.effect === undefined) return run
    const effect = run.effect
    if (effect?.kind !== "start_blueprint_loop" || effect.loopID !== loopID) {
      stateConflict(run, `no start effect exists for BlueprintLoop ${loopID}`)
    }

    return edit(run, (draft) => {
      const step = findStep(draft, effect.stepID)
      const attempt = step?.loopHistory.find((item) => item.loopID === loopID)
      if (!step || !attempt) stateConflict(draft, `BlueprintLoop ${loopID} is not recorded on its Step`)
      attempt.status = "running"
      attempt.time.started = now
      step.status = "executing"
      step.time.updated = now
      draft.effect = undefined
      advanceStateRevision(draft, now)
    })
  }

  export function onLoopTerminal(run: LatticeTypes.Run, input: LoopTerminalInput, now = Date.now()): LatticeTypes.Run {
    if (LatticeTypes.isTerminalRun(run.status)) return run
    const owner = run.pathway.find((step) => step.loopHistory.some((attempt) => attempt.loopID === input.loopID))
    const existing = owner?.loopHistory.find((attempt) => attempt.loopID === input.loopID)
    if (!owner || !existing) stateConflict(run, `BlueprintLoop ${input.loopID} is not owned by this Run`)
    if (existing.status === "completed" || existing.status === "failed" || existing.status === "cancelled") return run

    return edit(run, (draft) => {
      const step = findStep(draft, owner.id)!
      const attempt = step.loopHistory.find((item) => item.loopID === input.loopID)!
      attempt.status = input.status
      attempt.summary = input.summary
      attempt.error = input.error
      attempt.time.completed = now
      step.time.completed = now
      step.time.updated = now
      draft.effect = undefined

      if (input.status === "completed") {
        const wasPaused = draft.status === "paused"
        const pauseReason = draft.statusReason
        const pausedAt = draft.time.paused
        step.status = "completed"
        step.resultSummary = input.summary
        step.failureReason = undefined
        draft.currentStepID = undefined
        draft.statusReason = undefined
        draft.time.paused = undefined
        if (firstPendingStep(draft)) {
          draft.status = wasPaused ? "paused" : "active"
          draft.statusReason = wasPaused ? pauseReason : undefined
          draft.time.paused = wasPaused ? pausedAt : undefined
          setState(draft, "reviewing_pathway")
        } else {
          draft.status = "completed"
          draft.effect = {
            id: Identifier.ascending("lattice_effect"),
            kind: "deliver_completion",
            deliveryKey: LatticeTypes.completionDeliveryKey(draft.id),
            time: { created: now },
          }
          draft.time.completed = now
        }
      } else {
        const wasPaused = draft.status === "paused"
        const pauseReason = draft.statusReason
        const pausedAt = draft.time.paused
        step.status = input.status
        step.failureReason = input.error ?? `BlueprintLoop ${input.status}`
        draft.status = "paused"
        draft.statusReason = wasPaused
          ? pauseReason
          : input.status === "failed"
            ? "blueprint_loop_failed"
            : "blueprint_loop_cancelled"
        draft.time.paused = wasPaused ? pausedAt : now
      }
      advanceStateRevision(draft, now)
    })
  }

  export function setPromptEffect(
    run: LatticeTypes.Run,
    input: {
      promptType: LatticeTypes.PromptEffect["promptType"]
      deliveryKey?: string
      validationErrors?: string[]
    },
    now = Date.now(),
  ): LatticeTypes.Run {
    requireNoEffect(run)
    return edit(run, (draft) => {
      const id = Identifier.ascending("lattice_effect")
      draft.effect = {
        id,
        kind: "deliver_prompt",
        promptType: input.promptType,
        state: draft.state,
        deliveryKey: input.deliveryKey ?? `lattice:${draft.id}:prompt:${id}`,
        validationErrors: input.validationErrors,
        attemptCount: 0,
        time: { created: now },
      }
      draft.time.updated = now
    })
  }

  export function completeEffect(run: LatticeTypes.Run, effectID: string, now = Date.now()): LatticeTypes.Run {
    if (!run.effect || run.effect.id !== effectID) stateConflict(run, `effect ${effectID} is not pending`)
    return edit(run, (draft) => {
      draft.effect = undefined
      draft.time.updated = now
    })
  }

  export function pause(run: LatticeTypes.Run, reason: string, now = Date.now()): LatticeTypes.Run {
    if (LatticeTypes.isTerminalRun(run.status)) stateConflict(run, `terminal run cannot be paused (${run.status})`)
    if (run.status === "paused" && run.statusReason === reason) return run
    return edit(run, (draft) => {
      draft.status = "paused"
      draft.statusReason = reason
      draft.time.paused = now
      advanceStateRevision(draft, now)
    })
  }

  export function resume(
    run: LatticeTypes.Run,
    options: { preservePendingAction?: boolean } = {},
    now = Date.now(),
  ): LatticeTypes.Run {
    if (run.status !== "paused") stateConflict(run, `only a paused run can resume, got ${run.status}`)
    return edit(run, (draft) => {
      const step = findStep(draft, draft.currentStepID)
      const pauseReason = draft.statusReason
      const interruptedExecutionEffect =
        draft.effect?.kind === "create_blueprint_loop" || draft.effect?.kind === "start_blueprint_loop"
      draft.status = "active"
      draft.statusReason = undefined
      draft.time.paused = undefined
      draft.effect = undefined
      if (!options.preservePendingAction) draft.pendingAction = undefined
      if (
        draft.state === "executing" &&
        step &&
        (step.status === "failed" ||
          step.status === "cancelled" ||
          step.status === "current" ||
          interruptedExecutionEffect ||
          pauseReason === "duplicate_active_run" ||
          pauseReason === "blueprint_loop_ownership_conflict" ||
          pauseReason === "multiple_blueprint_loop_owners")
      ) {
        for (const attempt of step.loopHistory) {
          if (attempt.status !== "created" && attempt.status !== "running") continue
          attempt.status = "cancelled"
          attempt.error ??= `Lattice recovery reopened the Step after ${pauseReason}`
          attempt.time.completed = now
        }
        step.status = "current"
        step.time.completed = undefined
        step.time.updated = now
        setState(draft, "blueprinting")
      }
      advanceStateRevision(draft, now)
      if (draft.pendingAction) {
        draft.pendingAction.expectedStateRevision = draft.stateRevision
        draft.pendingAction.expectedPathwayRevision = draft.pathwayRevision
      }
    })
  }

  export function cancel(run: LatticeTypes.Run, now = Date.now()): LatticeTypes.Run {
    if (LatticeTypes.isTerminalRun(run.status)) return run
    return edit(run, (draft) => {
      // Creation can commit a Loop before its ID reaches loopHistory. Retain
      // this inactive-only breadcrumb until lifecycle cleanup proves convergence.
      const cleanupEffect = draft.effect?.kind === "create_blueprint_loop" ? draft.effect : undefined
      const step = findStep(draft, draft.currentStepID)
      if (step && !LatticeTypes.isTerminalStep(step.status)) {
        step.status = "cancelled"
        step.time.completed = now
        step.time.updated = now
        for (const attempt of step.loopHistory) {
          if (attempt.status !== "created" && attempt.status !== "running") continue
          attempt.status = "cancelled"
          attempt.error ??= "Lattice Run cancelled"
          attempt.time.completed = now
        }
      }
      draft.status = "cancelled"
      draft.statusReason = undefined
      draft.pendingAction = undefined
      draft.effect = cleanupEffect
      draft.time.paused = undefined
      draft.time.completed = now
      advanceStateRevision(draft, now)
    })
  }

  export function fail(run: LatticeTypes.Run, reason: string, now = Date.now()): LatticeTypes.Run {
    if (LatticeTypes.isTerminalRun(run.status)) return run
    return edit(run, (draft) => {
      draft.status = "failed"
      draft.statusReason = reason
      draft.pendingAction = undefined
      draft.effect = undefined
      draft.time.paused = undefined
      draft.time.completed = now
      advanceStateRevision(draft, now)
    })
  }

  export function markBudgetExhausted(run: LatticeTypes.Run, now = Date.now()): LatticeTypes.Run {
    return pause(run, "model_call_budget_exhausted", now)
  }

  export function quarantineDuplicate(run: LatticeTypes.Run, selected: boolean, now = Date.now()): LatticeTypes.Run {
    if (LatticeTypes.isTerminalRun(run.status)) return run
    return edit(run, (draft) => {
      // The Controller cannot execute effects on inactive Runs; this create
      // fingerprint exists only so cold recovery can find a pre-handoff Loop.
      const cleanupEffect = draft.effect?.kind === "create_blueprint_loop" ? draft.effect : undefined
      draft.pendingAction = undefined
      draft.effect = cleanupEffect
      draft.status = selected ? "paused" : "failed"
      draft.statusReason = "duplicate_active_run"
      if (!selected) {
        for (const step of draft.pathway) {
          let ownedActiveAttempt = false
          for (const attempt of step.loopHistory) {
            if (attempt.status !== "created" && attempt.status !== "running") continue
            ownedActiveAttempt = true
            attempt.status = "cancelled"
            attempt.error ??= "duplicate_active_run"
            attempt.time.completed = now
          }
          if (!ownedActiveAttempt && step.id !== draft.currentStepID) continue
          if (!LatticeTypes.isTerminalStep(step.status)) step.status = "failed"
          step.failureReason ??= "duplicate_active_run"
          step.time.completed ??= now
          step.time.updated = now
        }
        draft.currentStepID = undefined
      }
      draft.time.paused = selected ? now : undefined
      draft.time.completed = selected ? undefined : now
      advanceStateRevision(draft, now)
    })
  }
}
