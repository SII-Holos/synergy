import { BlueprintLoopService, BlueprintLoopStore } from "../blueprint"
import type { Info as BlueprintLoopInfo } from "../blueprint/types"
import { NoteDocument, NoteStore } from "../note"
import type { ContinuationKernel } from "../session/continuation-kernel"
import { SessionDrive } from "../session/drive"
import { SessionHistory } from "../session/history"
import { SessionInbox } from "../session/inbox"
import { Log } from "../util/log"
import { LatticeError } from "./error"
import { LatticeLock } from "./lock"
import { LatticeMachine } from "./machine"
import { LatticeModelCalls } from "./model-calls"
import { LatticePrompt } from "./prompt"
import { LatticeStore } from "./store"
import { LatticeTypes } from "./types"

export namespace LatticeController {
  const log = Log.create({ service: "lattice.controller" })

  export type DirectReason = "enable" | "resume" | "action" | "loop_terminal" | "note_change" | "startup"

  type GateOutcome = {
    result: ContinuationKernel.PolicyResult
    terminalRunID?: string
  }

  type DirectOutcome = {
    shouldDrive: boolean
    terminalRunID?: string
  }

  export async function reconcileGate(gate: ContinuationKernel.Gate): Promise<ContinuationKernel.PolicyResult> {
    let outcome: GateOutcome
    {
      using _ = await LatticeLock.write(gate.scopeID, gate.sessionID)
      outcome = await reconcileGateLocked(gate)
    }
    if (outcome.terminalRunID) {
      await clearTerminalWorkflowProjection(gate.sessionID, outcome.terminalRunID)
    }
    return outcome.result
  }

  async function reconcileGateLocked(gate: ContinuationKernel.Gate): Promise<GateOutcome> {
    let run = await LatticeStore.getOrUndefined(gate.scopeID, gate.sessionID)
    if (!run) return { result: undefined }
    if (run.status !== "active") {
      return {
        result: undefined,
        terminalRunID: LatticeTypes.isTerminalRun(run.status) ? run.id : undefined,
      }
    }

    const count = (await LatticeModelCalls.flush(gate.scopeID, gate.sessionID)) ?? run.modelCallCount
    run = await LatticeStore.get(gate.scopeID, gate.sessionID)
    if (run.maxModelCalls > 0 && count >= run.maxModelCalls) {
      await LatticeStore.updateByRunID(gate.scopeID, run.id, (draft) => LatticeMachine.markBudgetExhausted(draft))
      return { result: undefined }
    }

    run = await settleDeliveredPrompt(gate, run)
    run = await reconcileBlueprintRevision(gate.scopeID, run)
    run = await reconcileLoopRecords(gate.scopeID, run, false)
    run = await consumeAction(gate.scopeID, run)
    run = await executeEffects(gate.scopeID, run, false)

    if (run.status !== "active") {
      return {
        result: undefined,
        terminalRunID: LatticeTypes.isTerminalRun(run.status) ? run.id : undefined,
      }
    }
    if (run.effect?.kind === "deliver_prompt") return { result: promptProposal(run, run.effect) }
    if (run.effect || run.pendingAction) return { result: undefined }
    if (run.state === "awaiting_execution" || run.state === "executing") return { result: undefined }

    const text = LatticePrompt.continuation(run)
    if (!text) return { result: undefined }
    return {
      result: {
        kind: "inbox",
        deliveryKey: `lattice:${run.id}:continue:${gate.terminalMessageID}`,
        mode: "steer",
        message: promptMessage(run, text, "lattice_continuation"),
      },
    }
  }

  /** Reconcile without relying on the ContinuationKernel success gate. */
  export async function reconcileDirect(scopeID: string, sessionID: string, reason: DirectReason): Promise<void> {
    let outcome: DirectOutcome
    {
      using _ = await LatticeLock.write(scopeID, sessionID)
      outcome = await reconcileDirectLocked(scopeID, sessionID, reason)
    }
    if (outcome.terminalRunID) {
      await clearTerminalWorkflowProjection(sessionID, outcome.terminalRunID)
    }
    if (outcome.shouldDrive) await SessionDrive.request(sessionID, `lattice-${reason}`)
  }

  async function reconcileDirectLocked(
    scopeID: string,
    sessionID: string,
    reason: DirectReason,
  ): Promise<DirectOutcome> {
    let run = await LatticeStore.getOrUndefined(scopeID, sessionID)
    if (!run) return { shouldDrive: false }
    if (LatticeTypes.isTerminalRun(run.status)) {
      return { shouldDrive: false, terminalRunID: run.id }
    }
    if (run.status === "paused") {
      if (reason === "loop_terminal" || reason === "startup" || reason === "resume") {
        run = await reconcileLoopRecords(scopeID, run, reason === "startup")
      }
      return {
        shouldDrive: false,
        terminalRunID: LatticeTypes.isTerminalRun(run.status) ? run.id : undefined,
      }
    }

    const count = (await LatticeModelCalls.flush(scopeID, sessionID)) ?? run.modelCallCount
    run = await LatticeStore.get(scopeID, sessionID)
    if (!(await ensureWorkflowProjection(scopeID, run))) return { shouldDrive: false }

    run = await reconcileBlueprintRevision(scopeID, run)
    run = await reconcileLoopRecords(scopeID, run, reason === "startup")
    if (run.status !== "active") {
      return {
        shouldDrive: false,
        terminalRunID: LatticeTypes.isTerminalRun(run.status) ? run.id : undefined,
      }
    }
    if (run.maxModelCalls > 0 && count >= run.maxModelCalls) {
      await LatticeStore.updateByRunID(scopeID, run.id, (draft) => LatticeMachine.markBudgetExhausted(draft))
      return { shouldDrive: false }
    }
    run = await consumeAction(scopeID, run)
    run = await executeEffects(scopeID, run, reason === "startup")

    if (run.status !== "active") {
      return {
        shouldDrive: false,
        terminalRunID: LatticeTypes.isTerminalRun(run.status) ? run.id : undefined,
      }
    }
    if (run.effect?.kind !== "deliver_prompt") return { shouldDrive: false }
    const text = LatticePrompt.entry(run, {
      promptType: run.effect.promptType,
      failures: run.effect.validationErrors,
    })
    if (!text) return { shouldDrive: false }
    const delivery = await SessionInbox.deliverUnique({
      sessionID,
      deliveryKey: run.effect.deliveryKey,
      mode: "steer",
      message: promptMessage(run, text, `lattice_${run.effect.promptType}`),
    })
    const effectID = run.effect.id
    await LatticeStore.updateByRunID(scopeID, run.id, (draft) => {
      if (draft.effect?.kind !== "deliver_prompt" || draft.effect.id !== effectID) return
      draft.effect.deliveredMessageID = delivery.messageID
      draft.effect.attemptCount++
    })
    return { shouldDrive: true }
  }

  export async function reconcileScope(scopeID: string, coldStart: boolean): Promise<void> {
    const runs = await LatticeStore.listCurrent(scopeID)
    if (coldStart) {
      const { LatticeRunService } = await import("./run-service")
      const allRuns = await LatticeStore.list(scopeID)
      for (const run of allRuns) {
        if (run.status === "active") continue
        await LatticeRunService.cleanupInactiveRun(scopeID, run.id)
      }
    }
    for (const run of runs) {
      if (LatticeTypes.isTerminalRun(run.status)) continue
      await reconcileDirect(scopeID, run.sessionID, coldStart ? "startup" : "action").catch((error) => {
        log.error("scope reconciliation failed", { runID: run.id, error })
      })
    }
  }

  export async function onLoopChanged(loop: BlueprintLoopInfo): Promise<void> {
    if (loop.source !== "lattice") return
    const runs = await LatticeStore.listBySession(loop.scopeID, loop.sessionID)
    const owners = runs.filter((run) =>
      run.pathway.some((step) => step.loopHistory.some((attempt) => attempt.loopID === loop.id)),
    )
    if (owners.length > 1) {
      const current = await LatticeStore.getOrUndefined(loop.scopeID, loop.sessionID)
      if (current && !LatticeTypes.isTerminalRun(current.status)) {
        await LatticeStore.updateByRunID(loop.scopeID, current.id, (draft) =>
          LatticeMachine.pause(draft, "multiple_blueprint_loop_owners"),
        )
      }
      return
    }
    await reconcileDirect(loop.scopeID, loop.sessionID, "loop_terminal")
  }

  export async function onBlueprintChanged(scopeID: string, noteID: string): Promise<void> {
    const runs = await LatticeStore.listCurrent(scopeID)
    const affected = runs.filter((run) => {
      if (run.status !== "active" || run.state !== "awaiting_execution") return false
      return LatticeMachine.currentStep(run)?.blueprint?.noteID === noteID
    })
    await Promise.all(
      affected.map((run) => reconcileDirect(scopeID, run.sessionID, "note_change").catch(() => undefined)),
    )
  }

  async function ensureWorkflowProjection(scopeID: string, run: LatticeTypes.Run): Promise<boolean> {
    try {
      const { SessionWorkflowService } = await import("../session/workflow")
      await SessionWorkflowService.repairLatticeProjection({
        sessionID: run.sessionID,
        runID: run.id,
        mode: run.mode,
      })
      return true
    } catch (error) {
      log.warn("lattice workflow projection recovery failed", { runID: run.id, error })
      await LatticeStore.updateByRunID(scopeID, run.id, (draft) =>
        LatticeMachine.pause(draft, "workflow_projection_conflict"),
      )
      return false
    }
  }

  async function clearTerminalWorkflowProjection(sessionID: string, runID: string): Promise<void> {
    const { SessionWorkflowService } = await import("../session/workflow")
    await SessionWorkflowService.clearIfLattice(sessionID, runID)
  }

  async function settleDeliveredPrompt(
    gate: ContinuationKernel.Gate,
    run: LatticeTypes.Run,
  ): Promise<LatticeTypes.Run> {
    const effect = run.effect
    if (effect?.kind !== "deliver_prompt") return run
    const infos = await SessionHistory.messageInfos(run.sessionID)
    const delivered = infos.find(
      (info) => info.id === effect.deliveredMessageID || info.metadata?.inboxDeliveryKey === effect.deliveryKey,
    )
    const terminal = infos.find((info) => info.id === gate.terminalMessageID)
    if (!delivered || !terminal || terminal.time.created < delivered.time.created) return run
    return LatticeStore.updateByRunID(gate.scopeID, run.id, (draft) => LatticeMachine.completeEffect(draft, effect.id))
  }

  async function consumeAction(scopeID: string, run: LatticeTypes.Run): Promise<LatticeTypes.Run> {
    if (run.status !== "active" || !run.pendingAction || run.effect) return run
    try {
      await validatePendingAction(run)
      const updated = await LatticeStore.updateByRunID(scopeID, run.id, (draft) => {
        let next = LatticeMachine.consumePendingAction(draft)
        if (needsStateEntry(next)) next = LatticeMachine.setPromptEffect(next, { promptType: "state_entry" })
        return next
      })
      void LatticeStore.appendEvent(scopeID, updated, {
        kind: "action_consumed",
        state: updated.state,
        message: `${run.pendingAction!.kind} consumed`,
      }).catch(() => undefined)
      return updated
    } catch (error) {
      if (!(error instanceof LatticeError.StateConflict) && !(error instanceof LatticeError.InvalidPathway)) throw error
      const reason = error.data.reason
      return LatticeStore.updateByRunID(scopeID, run.id, (draft) => {
        draft.pendingAction = undefined
        return LatticeMachine.setPromptEffect(draft, {
          promptType: "repair",
          validationErrors: [reason],
        })
      })
    }
  }

  function needsStateEntry(run: LatticeTypes.Run): boolean {
    return (
      run.status === "active" &&
      run.effect === undefined &&
      run.state !== "awaiting_execution" &&
      run.state !== "executing"
    )
  }

  async function validatePendingAction(run: LatticeTypes.Run): Promise<void> {
    const action = run.pendingAction
    if (!action) return
    if (action.kind === "submit_blueprint") {
      const blueprint = await readBlueprint(run.scopeID, action.blueprintID)
      if (blueprint.version !== action.blueprintVersion || blueprint.digest !== action.contentDigest) {
        throw new LatticeError.StateConflict({ state: run.state, reason: "Blueprint changed after submission" })
      }
      return
    }
    if (action.kind !== "submit_blueprint_review" && action.kind !== "approve_execution") return
    const binding = LatticeMachine.currentStep(run)?.blueprint
    if (!binding) throw new LatticeError.StateConflict({ state: run.state, reason: "current Step has no Blueprint" })
    const blueprint = await readBlueprint(run.scopeID, binding.noteID)
    if (blueprint.version !== action.blueprintVersion || blueprint.digest !== action.contentDigest) {
      throw new LatticeError.StateConflict({ state: run.state, reason: "Blueprint changed after submission" })
    }
  }

  async function reconcileBlueprintRevision(scopeID: string, run: LatticeTypes.Run): Promise<LatticeTypes.Run> {
    if (run.status !== "active" || run.state !== "awaiting_execution") return run
    const binding = LatticeMachine.currentStep(run)?.blueprint
    if (!binding) return run
    const blueprint = await readBlueprint(scopeID, binding.noteID).catch(() => undefined)
    if (
      blueprint &&
      blueprint.version === binding.reviewedVersion &&
      blueprint.digest === binding.reviewedContentDigest
    ) {
      return run
    }
    if (!blueprint) {
      return LatticeStore.updateByRunID(scopeID, run.id, (draft) =>
        LatticeMachine.pause(draft, "blueprint_unavailable"),
      )
    }
    return LatticeStore.updateByRunID(scopeID, run.id, (draft) => {
      draft.pendingAction = undefined
      let next = LatticeMachine.invalidateBlueprintReview(draft, {
        version: blueprint.version,
        contentDigest: blueprint.digest,
      })
      next = LatticeMachine.setPromptEffect(next, { promptType: "state_entry" })
      return next
    })
  }

  async function executeEffects(
    scopeID: string,
    initial: LatticeTypes.Run,
    coldStart: boolean,
  ): Promise<LatticeTypes.Run> {
    let run = initial
    for (let iteration = 0; iteration < 4; iteration++) {
      if (run.status !== "active") return run
      const effect = run.effect
      if (!effect || effect.kind === "deliver_prompt") break

      if (effect.kind === "create_blueprint_loop") {
        const recovery = await matchingCreatedLoops(scopeID, run, effect)
        if (recovery.length > 1) return pauseOwnershipConflict(scopeID, run)
        let loop = recovery[0]
        if (!loop) {
          const blueprint = await readBlueprint(scopeID, effect.blueprintNoteID).catch(() => undefined)
          if (!blueprint || blueprint.version !== effect.blueprintVersion || blueprint.digest !== effect.sourceDigest) {
            return returnToBlueprintReview(scopeID, run, blueprint)
          }
          const step = run.pathway.find((candidate) => candidate.id === effect.stepID)
          if (!step) return pauseOwnershipConflict(scopeID, run)
          try {
            loop = await BlueprintLoopService.create({
              noteID: effect.blueprintNoteID,
              noteVersion: effect.blueprintVersion,
              title: step.title,
              description: step.objective,
              sessionID: run.sessionID,
              runMode: "current",
              source: "lattice",
              sourceDigest: effect.sourceDigest,
            })
          } catch (error) {
            log.warn("failed to create lattice BlueprintLoop", { runID: run.id, error })
            return pauseOwnershipConflict(scopeID, run)
          }
        }
        if (loop.status !== "armed" || loop.noteVersion !== effect.blueprintVersion) {
          return pauseOwnershipConflict(scopeID, run)
        }
        const linkedBlueprint = await readBlueprint(scopeID, effect.blueprintNoteID).catch(() => undefined)
        const expectedLinkedVersion =
          linkedBlueprint?.activeLoopID === loop.id ? effect.blueprintVersion + 1 : effect.blueprintVersion
        if (
          !linkedBlueprint ||
          linkedBlueprint.version !== expectedLinkedVersion ||
          linkedBlueprint.digest !== effect.sourceDigest
        ) {
          await BlueprintLoopStore.updateStatus(scopeID, loop.id, { status: "cancelled" })
          return returnToBlueprintReview(scopeID, run, linkedBlueprint)
        }
        run = await LatticeStore.updateByRunID(scopeID, run.id, (draft) =>
          LatticeMachine.onLoopCreated(draft, {
            loopID: loop!.id,
            blueprintVersion: linkedBlueprint.version,
            sourceDigest: effect.sourceDigest,
          }),
        )
        continue
      }

      const loop = await BlueprintLoopStore.get(scopeID, effect.loopID).catch(() => undefined)
      if (!loop || !ownsLoop(run, loop, effect.sourceDigest)) return pauseOwnershipConflict(scopeID, run)
      if (loop.status === "armed") {
        const blueprint = await readBlueprint(scopeID, loop.noteID).catch(() => undefined)
        if (!blueprint) return returnToBlueprintReview(scopeID, run, undefined)
        if (blueprint.version !== effect.blueprintVersion || blueprint.digest !== effect.sourceDigest) {
          return returnToBlueprintReview(scopeID, run, blueprint)
        }
        await BlueprintLoopService.start(scopeID, loop.id)
      }
      run = await LatticeStore.updateByRunID(scopeID, run.id, (draft) => LatticeMachine.onLoopStarted(draft, loop.id))
      run = await reconcileLoopRecords(scopeID, run, coldStart)
    }
    return run
  }

  async function reconcileLoopRecords(
    scopeID: string,
    initial: LatticeTypes.Run,
    coldStart: boolean,
  ): Promise<LatticeTypes.Run> {
    let run = initial
    const attempts = run.pathway.flatMap((step) =>
      step.loopHistory
        .filter((attempt) => attempt.status === "created" || attempt.status === "running")
        .map((attempt) => ({ step, attempt })),
    )
    if (attempts.length > 1) return pauseOwnershipConflict(scopeID, run)
    const owned = attempts[0]
    if (!owned) return run
    const loop = await BlueprintLoopStore.get(scopeID, owned.attempt.loopID).catch(() => undefined)
    if (!loop || !ownsLoop(run, loop, owned.attempt.sourceDigest)) return pauseOwnershipConflict(scopeID, run)

    if (loop.status === "completed" || loop.status === "failed" || loop.status === "cancelled") {
      const before = run
      const status = loop.status
      run = await LatticeStore.updateByRunID(scopeID, run.id, (draft) =>
        LatticeMachine.onLoopTerminal(draft, {
          loopID: loop.id,
          status,
          summary: loop.summary,
          error: loop.error,
        }),
      )
      if (before.status === "active" && run.status === "active" && run.state === "reviewing_pathway" && !run.effect) {
        run = await LatticeStore.updateByRunID(scopeID, run.id, (draft) =>
          LatticeMachine.setPromptEffect(draft, { promptType: "state_entry" }),
        )
      }
      return run
    }

    if (coldStart && loop.status === "running" && !(await hasLoopFirstPrompt(run.sessionID, loop.id))) {
      await BlueprintLoopService.deliverFirstPrompt(run.sessionID, loop)
    }
    return run
  }

  async function matchingCreatedLoops(
    scopeID: string,
    run: LatticeTypes.Run,
    effect: LatticeTypes.CreateBlueprintLoopEffect,
  ): Promise<BlueprintLoopInfo[]> {
    return (await BlueprintLoopStore.list(scopeID)).filter(
      (loop) =>
        loop.source === "lattice" &&
        loop.sessionID === run.sessionID &&
        loop.noteID === effect.blueprintNoteID &&
        loop.sourceDigest === effect.sourceDigest &&
        loop.time.created >= effect.time.created,
    )
  }

  function ownsLoop(run: LatticeTypes.Run, loop: BlueprintLoopInfo, digest: string): boolean {
    return (
      loop.source === "lattice" &&
      loop.scopeID === run.scopeID &&
      loop.sessionID === run.sessionID &&
      loop.sourceDigest === digest
    )
  }

  async function hasLoopFirstPrompt(sessionID: string, loopID: string): Promise<boolean> {
    const [inbox, messages] = await Promise.all([SessionInbox.list(sessionID), SessionHistory.messageInfos(sessionID)])
    return (
      inbox.some((item) => item.message?.metadata?.loopID === loopID) ||
      messages.some((message) => message.metadata?.loopID === loopID)
    )
  }

  async function pauseOwnershipConflict(scopeID: string, run: LatticeTypes.Run): Promise<LatticeTypes.Run> {
    if (run.status !== "active") return run
    return LatticeStore.updateByRunID(scopeID, run.id, (draft) =>
      LatticeMachine.pause(draft, "blueprint_loop_ownership_conflict"),
    )
  }

  async function returnToBlueprintReview(
    scopeID: string,
    run: LatticeTypes.Run,
    blueprint: { version: number; digest: string } | undefined,
  ): Promise<LatticeTypes.Run> {
    if (!blueprint) {
      return LatticeStore.updateByRunID(scopeID, run.id, (draft) =>
        LatticeMachine.pause(draft, "blueprint_unavailable"),
      )
    }
    if (run.effect?.kind === "start_blueprint_loop") {
      const loop = await BlueprintLoopStore.get(scopeID, run.effect.loopID).catch(() => undefined)
      if (loop?.status === "armed") {
        await BlueprintLoopStore.updateStatus(scopeID, loop.id, { status: "cancelled" })
      }
    }
    return LatticeStore.updateByRunID(scopeID, run.id, (draft) => {
      let next = LatticeMachine.invalidateBlueprintReview(draft, {
        version: blueprint.version,
        contentDigest: blueprint.digest,
      })
      next = LatticeMachine.setPromptEffect(next, { promptType: "state_entry" })
      return next
    })
  }

  async function readBlueprint(
    scopeID: string,
    noteID: string,
  ): Promise<{ version: number; digest: string; activeLoopID?: string }> {
    const note = await NoteStore.getAny(scopeID, noteID).catch(() => undefined)
    if (!note || note.kind !== "blueprint" || note.archived) {
      throw new LatticeError.StateConflict({
        state: "blueprinting",
        reason: `Blueprint ${noteID} is unavailable`,
      })
    }
    return {
      version: note.version,
      digest: NoteDocument.hash(note.content),
      activeLoopID: note.blueprint?.activeLoopID,
    }
  }

  function promptProposal(run: LatticeTypes.Run, effect: LatticeTypes.PromptEffect): ContinuationKernel.InboxProposal {
    const text = LatticePrompt.entry(run, {
      promptType: effect.promptType,
      failures: effect.validationErrors,
    })
    return {
      kind: "inbox",
      deliveryKey: effect.deliveryKey,
      mode: "steer",
      message: promptMessage(run, text, `lattice_${effect.promptType}`),
    }
  }

  function promptMessage(
    run: LatticeTypes.Run,
    text: string,
    source: string,
  ): ContinuationKernel.InboxProposal["message"] {
    return {
      role: "user",
      visible: false,
      origin: { type: "system" },
      summary: { title: "Continue Lattice workflow" },
      metadata: { source, runID: run.id, state: run.state },
      parts: [{ type: "text", text, synthetic: true }],
    }
  }
}
