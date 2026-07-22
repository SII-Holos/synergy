import { BlueprintLoopStore, type Info as BlueprintLoopInfo } from "../blueprint"
import { isActiveLoopStatus } from "../blueprint/loop-store"
import { ScopeContext } from "../scope/context"
import { Session } from "../session"
import { SessionAbort } from "../session/abort"
import { SessionHistory } from "../session/history"
import { SessionInbox } from "../session/inbox"
import { LatticeActionService } from "./action-service"
import { LatticeError } from "./error"
import { LatticeLock } from "./lock"
import { LatticeMachine } from "./machine"
import { LatticeModelCalls } from "./model-calls"
import { LatticeStore } from "./store"
import { LatticeTypes } from "./types"

/**
 * Owns explicit Lattice lifecycle requests. Every canonical Run transition is
 * persisted before touching Session Inbox, Session execution, or a
 * BlueprintLoop. Recovery and normal progression remain Controller-owned.
 */
export namespace LatticeRunService {
  export type EnableInput = {
    sessionID: string
    mode: LatticeTypes.Mode
    maxModelCalls?: number
    goal?: string
  }

  type DirectReason = "enable" | "resume" | "action" | "note_change"

  async function reconcileDirect(scopeID: string, sessionID: string, reason: DirectReason): Promise<void> {
    const { LatticeController } = await import("./controller")
    await LatticeController.reconcileDirect(scopeID, sessionID, reason)
  }

  async function currentScopeSession(sessionID: string): Promise<Session.Info> {
    const scopeID = ScopeContext.current.scope.id
    const session = await Session.get(sessionID)
    if (session.scope.id !== scopeID) {
      throw new LatticeError.NotFound({ sessionID })
    }
    return session
  }

  async function assertCurrentRun(scopeID: string, run: LatticeTypes.Run): Promise<void> {
    const current = await LatticeStore.getOrUndefined(scopeID, run.sessionID)
    if (current?.id === run.id) return
    throw new LatticeError.StateConflict({
      state: run.state,
      reason: `Lattice Run ${run.id} is historical; current Run is ${current?.id ?? "missing"}.`,
    })
  }

  export async function assertNoForeignLoop(session: Session.Info): Promise<void> {
    const loopID = session.blueprint?.loopID
    if (!loopID) return
    const scopeID = ScopeContext.current.scope.id
    const loop = await BlueprintLoopStore.get(scopeID, loopID).catch(() => undefined)
    if (!loop || !isActiveLoopStatus(loop.status)) return
    throw new LatticeError.StateConflict({
      state: "clarifying",
      reason: `Session ${session.id} has an active BlueprintLoop; complete or cancel it before enabling Lattice.`,
    })
  }

  function ownedLoopReference(run: LatticeTypes.Run): { loopID: string; sourceDigest: string } | undefined {
    const step = LatticeMachine.currentStep(run)
    const attempt = step?.loopHistory.findLast(
      (candidate) => candidate.status === "created" || candidate.status === "running",
    )
    if (attempt) return { loopID: attempt.loopID, sourceDigest: attempt.sourceDigest }
    if (run.effect?.kind === "start_blueprint_loop") {
      return { loopID: run.effect.loopID, sourceDigest: run.effect.sourceDigest }
    }
    const latest = step?.loopHistory.at(-1)
    return latest && { loopID: latest.loopID, sourceDigest: latest.sourceDigest }
  }

  function ownedLoopReferences(run: LatticeTypes.Run): { loopID: string; sourceDigest: string }[] {
    const references = new Map<string, { loopID: string; sourceDigest: string }>()
    for (const step of run.pathway) {
      for (const attempt of step.loopHistory) {
        const reference = { loopID: attempt.loopID, sourceDigest: attempt.sourceDigest }
        references.set(`${reference.loopID}:${reference.sourceDigest}`, reference)
      }
    }
    if (run.effect?.kind === "start_blueprint_loop") {
      const reference = { loopID: run.effect.loopID, sourceDigest: run.effect.sourceDigest }
      references.set(`${reference.loopID}:${reference.sourceDigest}`, reference)
    }
    return [...references.values()]
  }

  function claimsLoop(run: LatticeTypes.Run, reference: { loopID: string; sourceDigest: string }): boolean {
    return ownedLoopReferences(run).some(
      (candidate) => candidate.loopID === reference.loopID && candidate.sourceDigest === reference.sourceDigest,
    )
  }

  function lifecycleTransitionTime(run: LatticeTypes.Run): number | undefined {
    if (run.status === "paused") return run.time.paused
    if (LatticeTypes.isTerminalRun(run.status)) return run.time.completed
    return undefined
  }

  function matchesCreateFingerprint(
    loop: BlueprintLoopInfo,
    run: LatticeTypes.Run,
    effect: LatticeTypes.CreateBlueprintLoopEffect,
    transitionTime: number,
  ): boolean {
    return (
      loop.scopeID === run.scopeID &&
      loop.sessionID === run.sessionID &&
      loop.source === "lattice" &&
      loop.noteID === effect.blueprintNoteID &&
      loop.noteVersion === effect.blueprintVersion &&
      loop.sourceDigest === effect.sourceDigest &&
      loop.time.created >= effect.time.created &&
      loop.time.created <= transitionTime
    )
  }

  function competingRunProtectsLoop(
    candidate: LatticeTypes.Run,
    target: LatticeTypes.Run,
    loop: BlueprintLoopInfo,
    transitionTime: number,
  ): boolean {
    if (candidate.id === target.id) return false
    const reference = { loopID: loop.id, sourceDigest: loop.sourceDigest ?? "" }
    const createdAfterTransition = candidate.time.created >= transitionTime
    if (candidate.status !== "active" && !createdAfterTransition) return false
    if (claimsLoop(candidate, reference)) return true
    const effect = candidate.effect
    return (
      effect?.kind === "create_blueprint_loop" &&
      loop.scopeID === candidate.scopeID &&
      loop.sessionID === candidate.sessionID &&
      loop.source === "lattice" &&
      loop.noteID === effect.blueprintNoteID &&
      loop.noteVersion === effect.blueprintVersion &&
      loop.sourceDigest === effect.sourceDigest &&
      loop.time.created >= effect.time.created
    )
  }

  async function matchingCreateWindowLoops(scopeID: string, run: LatticeTypes.Run): Promise<BlueprintLoopInfo[]> {
    const effect = run.effect
    if (effect?.kind !== "create_blueprint_loop") return []
    const transitionTime = lifecycleTransitionTime(run)
    if (transitionTime === undefined) {
      throw new LatticeError.StateConflict({
        state: run.state,
        reason: `Inactive Lattice Run ${run.id} is missing its persisted lifecycle transition time.`,
      })
    }
    const [loops, runs] = await Promise.all([
      BlueprintLoopStore.list(scopeID),
      LatticeStore.listBySession(scopeID, run.sessionID),
    ])
    const rawCandidates = loops.filter(
      (loop) =>
        matchesCreateFingerprint(loop, run, effect, transitionTime) &&
        !runs.some((candidate) => competingRunProtectsLoop(candidate, run, loop, transitionTime)),
    )
    const canonical = await Promise.all(
      rawCandidates.map((loop) => BlueprintLoopStore.get(scopeID, loop.id).catch(() => undefined)),
    )
    return canonical.filter(
      (loop): loop is BlueprintLoopInfo =>
        loop !== undefined &&
        matchesCreateFingerprint(loop, run, effect, transitionTime) &&
        !runs.some((candidate) => competingRunProtectsLoop(candidate, run, loop, transitionTime)),
    )
  }

  async function cancelLoopIfActive(scopeID: string, loop: BlueprintLoopInfo, error: string): Promise<boolean> {
    if (!isActiveLoopStatus(loop.status)) return false
    try {
      await BlueprintLoopStore.updateStatus(scopeID, loop.id, { status: "cancelled", error })
      return true
    } catch (cause) {
      const latest = await BlueprintLoopStore.get(scopeID, loop.id).catch(() => undefined)
      if (!latest || !isActiveLoopStatus(latest.status)) return false
      throw cause
    }
  }

  async function cancelRunLoops(
    scopeID: string,
    run: LatticeTypes.Run,
    error: string,
  ): Promise<{ recordedLoopIDs: string[] }> {
    const transitionTime = lifecycleTransitionTime(run)
    const competingRuns = await LatticeStore.listBySession(scopeID, run.sessionID)
    const recordedLoopIDs: string[] = []
    const candidates = new Map<string, { loop: BlueprintLoopInfo; recorded: boolean }>()

    for (const reference of ownedLoopReferences(run)) {
      const loop = await BlueprintLoopStore.get(scopeID, reference.loopID).catch(() => undefined)
      if (!loop) continue
      if (
        loop.id !== reference.loopID ||
        loop.scopeID !== scopeID ||
        loop.source !== "lattice" ||
        loop.sessionID !== run.sessionID ||
        loop.sourceDigest !== reference.sourceDigest
      ) {
        continue
      }
      if (
        transitionTime !== undefined &&
        competingRuns.some((candidate) => competingRunProtectsLoop(candidate, run, loop, transitionTime))
      ) {
        continue
      }
      candidates.set(loop.id, { loop, recorded: true })
    }

    for (const loop of await matchingCreateWindowLoops(scopeID, run)) {
      const existing = candidates.get(loop.id)
      candidates.set(loop.id, { loop, recorded: existing?.recorded ?? false })
    }

    for (const { loop, recorded } of candidates.values()) {
      if (!(await cancelLoopIfActive(scopeID, loop, error))) continue
      if (recorded) recordedLoopIDs.push(loop.id)
    }
    return { recordedLoopIDs }
  }

  async function completeCreateCleanupEffect(scopeID: string, run: LatticeTypes.Run): Promise<LatticeTypes.Run> {
    const effect = run.effect
    if (effect?.kind !== "create_blueprint_loop") return run
    return LatticeStore.updateByRunID(scopeID, run.id, (draft) => {
      if (draft.effect?.kind !== "create_blueprint_loop" || draft.effect.id !== effect.id) return
      return LatticeMachine.completeEffect(draft, effect.id)
    })
  }

  async function removeRunInbox(run: LatticeTypes.Run): Promise<void> {
    const prefix = `lattice:${run.id}:`
    const items = await SessionInbox.list(run.sessionID)
    for (const item of items) {
      if (!item.deliveryKey?.startsWith(prefix)) continue
      await SessionInbox.remove({ sessionID: run.sessionID, itemID: item.id })
    }
  }

  /** @internal Cold-start convergence before SessionInvoke resumes pending work. */
  export async function cleanupInactiveRun(scopeID: string, runID: string): Promise<LatticeTypes.Run | undefined> {
    let cleaned: LatticeTypes.Run | undefined
    let clearTerminalProjection = false
    {
      const snapshot = await LatticeStore.getByRunID(scopeID, runID)
      if (!snapshot || snapshot.status === "active") return snapshot
      using _ = await LatticeLock.write(scopeID, snapshot.sessionID)
      const run = await LatticeStore.getByRunID(scopeID, runID)
      if (!run || run.status === "active") return run

      await removeRunInbox(run)
      const { recordedLoopIDs: cancelledLoopIDs } = await cancelRunLoops(
        scopeID,
        run,
        "Lattice cold-start recovery cancelled work owned by an inactive Run",
      )
      cleaned = run
      if (run.status === "paused") {
        for (const loopID of cancelledLoopIDs) {
          const hasActiveAttempt = cleaned.pathway.some((step) =>
            step.loopHistory.some(
              (attempt) => attempt.loopID === loopID && (attempt.status === "created" || attempt.status === "running"),
            ),
          )
          if (!hasActiveAttempt) continue
          cleaned = await LatticeStore.updateByRunID(scopeID, run.id, (draft) => {
            if (draft.status !== "paused") return
            return LatticeMachine.onLoopTerminal(draft, {
              loopID,
              status: "cancelled",
              error: "Lattice cold-start recovery cancelled the owned BlueprintLoop",
            })
          })
        }
      }
      cleaned = await completeCreateCleanupEffect(scopeID, cleaned)
      clearTerminalProjection = LatticeTypes.isTerminalRun(cleaned.status)
    }

    if (cleaned && clearTerminalProjection) {
      const { SessionWorkflowService } = await import("../session/workflow")
      await SessionWorkflowService.clearIfLattice(cleaned.sessionID, cleaned.id)
    }
    return cleaned
  }

  async function appendLifecycleEvent(
    scopeID: string,
    run: LatticeTypes.Run,
    kind: "run_paused" | "run_resumed" | "run_cancelled",
    message: string,
  ): Promise<void> {
    await LatticeStore.appendEvent(scopeID, run, { kind, state: run.state, message }).catch(() => undefined)
  }

  export async function enable(input: EnableInput): Promise<LatticeTypes.Run> {
    const scopeID = ScopeContext.current.scope.id
    const session = await currentScopeSession(input.sessionID)
    using _ = await LatticeLock.write(scopeID, input.sessionID)
    const existing = await LatticeStore.getOrUndefined(scopeID, input.sessionID)

    if (existing?.status === "active") {
      return LatticeStore.updateByRunID(scopeID, existing.id, (draft) => {
        draft.mode = input.mode
        if (input.maxModelCalls !== undefined) draft.maxModelCalls = input.maxModelCalls
      })
    }

    if (existing?.status === "paused") {
      throw new LatticeError.StateConflict({
        state: existing.state,
        reason: "A paused Lattice Run requires explicit resume; workflow configuration cannot advance or replace it.",
      })
    }

    await assertNoForeignLoop(session)
    // A terminal Run can still have an in-memory soft-budget delta if the
    // process was interrupted around lifecycle cleanup. Never let that delta
    // become the first model call of the replacement Run.
    if (existing && LatticeTypes.isTerminalRun(existing.status)) {
      LatticeModelCalls.clear(input.sessionID)
    }
    let run = await LatticeStore.create({
      sessionID: input.sessionID,
      mode: input.mode,
      maxModelCalls: input.maxModelCalls,
      goal: input.goal,
    })

    if (input.goal?.trim()) {
      run = await LatticeStore.updateByRunID(scopeID, run.id, (draft) =>
        LatticeMachine.setPromptEffect(draft, { promptType: "state_entry" }),
      )
    }
    return run
  }

  async function pauseRun(run: LatticeTypes.Run, reason: string): Promise<LatticeTypes.Run> {
    const scopeID = ScopeContext.current.scope.id
    using _ = await LatticeLock.write(scopeID, run.sessionID)
    await LatticeModelCalls.flush(scopeID, run.sessionID)
    let paused = await LatticeStore.updateByRunID(scopeID, run.id, (draft) => LatticeMachine.pause(draft, reason))

    await SessionAbort.abort(run.sessionID)
    await removeRunInbox(paused)
    const { recordedLoopIDs } = await cancelRunLoops(
      scopeID,
      paused,
      reason === "user_exit" ? "Lattice workflow exited" : "Lattice Run paused by user",
    )

    for (const cancelledLoopID of recordedLoopIDs) {
      paused = await LatticeStore.updateByRunID(scopeID, run.id, (draft) => {
        const converged = LatticeMachine.onLoopTerminal(draft, {
          loopID: cancelledLoopID,
          status: "cancelled",
          error: reason === "user_exit" ? "Lattice workflow exited" : "Lattice Run paused by user",
        })
        return LatticeMachine.pause(converged, reason)
      })
    }
    paused = await completeCreateCleanupEffect(scopeID, paused)

    await appendLifecycleEvent(scopeID, paused, "run_paused", reason)
    return paused
  }

  export async function pause(runID: string): Promise<LatticeTypes.Run> {
    const scopeID = ScopeContext.current.scope.id
    const run = await LatticeStore.getByRunID(scopeID, runID)
    if (!run) throw new LatticeError.NotFound({ runID })
    await assertCurrentRun(scopeID, run)
    return pauseRun(run, "user_paused")
  }

  /** Pause the current Run before SessionWorkflowService clears its projection. */
  export async function disable(sessionID: string): Promise<LatticeTypes.Run | undefined> {
    const scopeID = ScopeContext.current.scope.id
    const run = await LatticeStore.getOrUndefined(scopeID, sessionID)
    if (!run || LatticeTypes.isTerminalRun(run.status)) return run
    return pauseRun(run, "user_exit")
  }

  function actionMatchesState(action: LatticeTypes.PendingAction, state: LatticeTypes.State): boolean {
    const expected: Record<LatticeTypes.PendingAction["kind"], LatticeTypes.State> = {
      submit_requirements: "clarifying",
      submit_pathway: "planning",
      submit_pathway_review: "reviewing_pathway",
      submit_blueprint: "blueprinting",
      submit_blueprint_review: "reviewing_blueprint",
      approve_execution: "awaiting_execution",
    }
    return expected[action.kind] === state
  }

  function hasValidPendingAction(run: LatticeTypes.Run): boolean {
    const action = run.pendingAction
    if (!action) return false
    return (
      action.expectedStateRevision <= run.stateRevision &&
      action.expectedPathwayRevision === run.pathwayRevision &&
      actionMatchesState(action, run.state)
    )
  }

  async function activeOwnedLoop(scopeID: string, run: LatticeTypes.Run) {
    const reference = ownedLoopReference(run)
    if (!reference) return undefined
    const loop = await BlueprintLoopStore.get(scopeID, reference.loopID).catch(() => undefined)
    if (!loop || !isActiveLoopStatus(loop.status)) return undefined
    if (loop.source !== "lattice" || loop.sessionID !== run.sessionID || loop.sourceDigest !== reference.sourceDigest) {
      throw new LatticeError.StateConflict({
        state: run.state,
        reason: `BlueprintLoop ${loop.id} is not owned by this Lattice Run.`,
      })
    }
    return loop
  }

  async function resumeActive(scopeID: string, snapshot: LatticeTypes.Run): Promise<LatticeTypes.Run> {
    let run: LatticeTypes.Run
    let shouldReconcile = false
    {
      using _ = await LatticeLock.write(scopeID, snapshot.sessionID)
      const latest = await LatticeStore.getByRunID(scopeID, snapshot.id)
      if (!latest) throw new LatticeError.NotFound({ runID: snapshot.id })
      const current = await LatticeStore.getOrUndefined(scopeID, latest.sessionID)
      if (current?.id !== latest.id) {
        throw new LatticeError.StateConflict({
          state: latest.state,
          reason: `Lattice Run ${latest.id} is historical; current Run is ${current?.id ?? "missing"}.`,
        })
      }
      if (latest.status !== "active") {
        throw new LatticeError.StateConflict({
          state: latest.state,
          reason: `Active Resume raced with Run status ${latest.status}; retry against the latest Run state.`,
        })
      }
      run = latest

      if (run.state === "executing") {
        if (run.effect?.kind !== "create_blueprint_loop" && run.effect?.kind !== "start_blueprint_loop") {
          const loop = await activeOwnedLoop(scopeID, run)
          if (loop) {
            throw new LatticeError.StateConflict({
              state: run.state,
              reason: `BlueprintLoop ${loop.id} is still executing; the parent Run cannot be resumed.`,
            })
          }
        }
        shouldReconcile = true
      } else if (run.state === "awaiting_execution") {
        shouldReconcile = Boolean(run.pendingAction || run.effect)
      } else {
        if (run.effect?.kind === "deliver_prompt" && (await promptWasMaterialized(run))) {
          const effectID = run.effect.id
          run = await LatticeStore.updateByRunID(scopeID, run.id, (draft) => {
            if (draft.effect?.kind !== "deliver_prompt" || draft.effect.id !== effectID) return
            return LatticeMachine.setPromptEffect(LatticeMachine.completeEffect(draft, effectID), {
              promptType: "resume",
            })
          })
        }

        if (!run.pendingAction && !run.effect) {
          run = await LatticeStore.updateByRunID(scopeID, run.id, (draft) => {
            if (draft.status !== "active" || draft.pendingAction || draft.effect) return
            if (draft.state === "awaiting_execution" || draft.state === "executing") return
            return LatticeMachine.setPromptEffect(draft, { promptType: "resume" })
          })
        }
        shouldReconcile = true
      }
    }

    if (shouldReconcile) await reconcileDirect(scopeID, run.sessionID, "resume")
    const resumed = (await LatticeStore.getByRunID(scopeID, run.id)) ?? run
    void LatticeStore.appendEvent(scopeID, resumed, {
      kind: "recovery_reconciled",
      state: resumed.state,
      message: "Active Lattice Run explicitly resumed after an interrupted parent turn",
    }).catch(() => undefined)
    return resumed
  }

  async function promptWasMaterialized(run: LatticeTypes.Run): Promise<boolean> {
    const effect = run.effect
    if (effect?.kind !== "deliver_prompt") return false
    const messages = await SessionHistory.messageInfos(run.sessionID)
    return messages.some(
      (message) =>
        message.id === effect.deliveredMessageID || message.metadata?.inboxDeliveryKey === effect.deliveryKey,
    )
  }

  export async function resume(runID: string): Promise<LatticeTypes.Run> {
    const scopeID = ScopeContext.current.scope.id
    let run = await LatticeStore.getByRunID(scopeID, runID)
    if (!run) throw new LatticeError.NotFound({ runID })
    await assertCurrentRun(scopeID, run)
    if (run.status === "active") return resumeActive(scopeID, run)
    if (run.status !== "paused") {
      throw new LatticeError.StateConflict({
        state: run.state,
        reason: `Only a paused Run can resume; got ${run.status}.`,
      })
    }

    run = (await cleanupInactiveRun(scopeID, run.id)) ?? run
    await reconcileDirect(scopeID, run.sessionID, "resume")
    run = (await LatticeStore.getByRunID(scopeID, run.id)) ?? run
    if (LatticeTypes.isTerminalRun(run.status)) return run
    if (run.status === "active") return resumeActive(scopeID, run)
    if (run.status !== "paused") {
      throw new LatticeError.StateConflict({
        state: run.state,
        reason: `Only a paused Run can resume; got ${run.status}.`,
      })
    }

    let resumed: LatticeTypes.Run
    let transitioned = false
    {
      using _ = await LatticeLock.write(scopeID, run.sessionID)
      const latest = await LatticeStore.getByRunID(scopeID, run.id)
      if (!latest) throw new LatticeError.NotFound({ runID })
      const current = await LatticeStore.getOrUndefined(scopeID, latest.sessionID)
      if (current?.id !== latest.id) {
        throw new LatticeError.StateConflict({
          state: latest.state,
          reason: `Lattice Run ${latest.id} is historical; current Run is ${current?.id ?? "missing"}.`,
        })
      }
      if (latest.status === "active") {
        resumed = latest
      } else {
        if (latest.status !== "paused") {
          throw new LatticeError.StateConflict({
            state: latest.state,
            reason: `Only a paused Run can resume; got ${latest.status}.`,
          })
        }
        const preservePendingAction = hasValidPendingAction(latest)
        resumed = await LatticeStore.updateByRunID(scopeID, latest.id, (draft) => {
          if (
            draft.statusReason === "model_call_budget_exhausted" &&
            draft.maxModelCalls > 0 &&
            draft.modelCallCount >= draft.maxModelCalls
          ) {
            // An explicit Resume is an explicit one-call budget extension. It
            // keeps the cap visible and prevents an immediately re-paused Run.
            draft.maxModelCalls = draft.modelCallCount + 1
          }
          let next = LatticeMachine.resume(draft, { preservePendingAction })
          if (!preservePendingAction && next.state !== "awaiting_execution" && next.state !== "executing") {
            next = LatticeMachine.setPromptEffect(next, { promptType: "resume" })
          }
          return next
        })
        transitioned = true
      }
    }

    if (!transitioned) return resumeActive(scopeID, resumed)
    await appendLifecycleEvent(scopeID, resumed, "run_resumed", "Lattice Run resumed")
    await reconcileDirect(scopeID, resumed.sessionID, "resume")
    resumed = (await LatticeStore.getByRunID(scopeID, resumed.id)) ?? resumed
    return resumed
  }

  export async function cancel(runID: string): Promise<LatticeTypes.Run> {
    const scopeID = ScopeContext.current.scope.id
    const snapshot = await LatticeStore.getByRunID(scopeID, runID)
    if (!snapshot) throw new LatticeError.NotFound({ runID })
    let cancelled: LatticeTypes.Run
    {
      using _ = await LatticeLock.write(scopeID, snapshot.sessionID)
      const run = await LatticeStore.getByRunID(scopeID, runID)
      if (!run) throw new LatticeError.NotFound({ runID })
      const current = await LatticeStore.getOrUndefined(scopeID, run.sessionID)
      const isCurrent = current?.id === run.id

      if (run.status === "cancelled") {
        if (isCurrent) {
          LatticeModelCalls.clear(run.sessionID)
          await SessionAbort.abort(run.sessionID)
        }
        await removeRunInbox(run)
        await cancelRunLoops(scopeID, run, "Lattice Run cancelled")
        cancelled = await completeCreateCleanupEffect(scopeID, run)
      } else if (run.status === "completed" || run.status === "failed") {
        throw new LatticeError.StateConflict({
          state: run.state,
          reason: `Terminal ${run.status} Run cannot be cancelled.`,
        })
      } else {
        if (!isCurrent) {
          throw new LatticeError.StateConflict({
            state: run.state,
            reason: `Lattice Run ${run.id} is historical; current Run is ${current?.id ?? "missing"}.`,
          })
        }
        await LatticeModelCalls.flush(scopeID, run.sessionID)
        cancelled = await LatticeStore.updateByRunID(scopeID, run.id, (draft) => LatticeMachine.cancel(draft))
        const currentAfterPersistence = await LatticeStore.getOrUndefined(scopeID, run.sessionID)
        if (currentAfterPersistence?.id === run.id) await SessionAbort.abort(run.sessionID)
        await removeRunInbox(cancelled)
        await cancelRunLoops(scopeID, cancelled, "Lattice Run cancelled")
        cancelled = await completeCreateCleanupEffect(scopeID, cancelled)
        await appendLifecycleEvent(scopeID, cancelled, "run_cancelled", "Lattice Run cancelled")
      }
    }
    const { SessionWorkflowService } = await import("../session/workflow")
    await SessionWorkflowService.clearIfLattice(snapshot.sessionID, snapshot.id)
    return cancelled
  }

  export async function approve(runID: string): Promise<LatticeTypes.Run> {
    const scopeID = ScopeContext.current.scope.id
    let run = await LatticeStore.getByRunID(scopeID, runID)
    if (!run) throw new LatticeError.NotFound({ runID })
    await assertCurrentRun(scopeID, run)
    await reconcileDirect(scopeID, run.sessionID, "note_change")
    run = (await LatticeStore.getByRunID(scopeID, run.id)) ?? run
    if (run.status !== "active" || run.state !== "awaiting_execution") {
      throw new LatticeError.StateConflict({
        state: run.state,
        reason: "The Run or reviewed Blueprint changed before execution approval.",
      })
    }
    try {
      await LatticeActionService.submit({
        scopeID,
        sessionID: run.sessionID,
        source: "panel",
        input: { action: "approve_execution", reason: "Approved in Lattice Panel" },
      })
    } catch (error) {
      if (error instanceof LatticeError.StateConflict) {
        await reconcileDirect(scopeID, run.sessionID, "note_change")
      }
      throw error
    }
    await reconcileDirect(scopeID, run.sessionID, "action")
    const reconciled = (await LatticeStore.getByRunID(scopeID, run.id)) ?? run
    if (
      reconciled.status === "active" &&
      (reconciled.state === "awaiting_execution" || reconciled.state === "reviewing_blueprint")
    ) {
      throw new LatticeError.StateConflict({
        state: reconciled.state,
        reason: "Execution approval was not applied because the reviewed Blueprint or Run revision changed.",
      })
    }
    return reconciled
  }
}
