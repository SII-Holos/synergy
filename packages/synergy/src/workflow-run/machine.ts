import { Log } from "../util/log"
import { CharterStore } from "./charter-store"
import { WorkflowEffects } from "./effects"
import { WorkflowError } from "./error"
import { WorkflowGuards } from "./guards"
import { WorkflowRunStore } from "./store"
import { WorkflowTypes } from "./types"

/**
 * WorkflowMachine owns every entity state transition. Agent-facing tools only
 * submit intents; the bridge only reports platform facts. All authorization
 * (allowedSeats), guard evaluation, state writes, and effect scheduling are
 * computed here. State is written first and committed before effects run, so a
 * session woken by an effect always observes the new state (same ordering
 * discipline as LatticeExecution).
 */
export namespace WorkflowMachine {
  const log = Log.create({ service: "workflow.machine" })

  export type IntentResult = { ok: true; run: WorkflowTypes.Run; entityState: string } | { ok: false; reason: string }

  function seatOf(run: WorkflowTypes.Run, sessionID: string): { seat: string; instance: number } | undefined {
    const binding = run.seats.find((s) => s.sessionID === sessionID)
    return binding ? { seat: binding.seat, instance: binding.instance } : undefined
  }

  async function charterFor(run: WorkflowTypes.Run): Promise<WorkflowTypes.Charter> {
    return CharterStore.get(run.scopeID, run.charterRef.id, run.charterRef.version)
  }

  /**
   * Apply a single transition: authorize → guards → commit state → run effects.
   * `transition` must have `from === entity.state`. Returns after state commit;
   * effects run afterwards (their failures block the entity independently).
   */
  async function applyTransition(input: {
    scopeID: string
    run: WorkflowTypes.Run
    charter: WorkflowTypes.Charter
    entity: WorkflowTypes.Entity
    transition: WorkflowTypes.TransitionDef
    submission?: WorkflowTypes.Submission
    triggerKind: "event" | "intent" | "gate"
  }): Promise<{ ok: true } | { ok: false; reason: string }> {
    const { scopeID, run, charter, entity, transition } = input

    // A submission delivered with the intent is part of the state the guard sees
    // — workflow_submit records the result and clears its own guard in one call.
    const guardEntity = input.submission
      ? { ...entity, submissions: [...entity.submissions, input.submission] }
      : entity
    const guardCtx: WorkflowGuards.Context = { scopeID, run, entity: guardEntity }
    const guardResult = await WorkflowGuards.evaluateAll(guardCtx, transition.guards)
    if (!guardResult.ok) {
      await WorkflowRunStore.appendEvent(
        scopeID,
        { id: run.id },
        {
          kind: "guard_failed",
          entityID: entity.id,
          transitionID: transition.id,
          message: guardResult.reason,
        },
      )
      const shouldBlock = transition.blockOnGuardFail ?? input.triggerKind === "event"
      if (shouldBlock) {
        await WorkflowRunStore.update(scopeID, run.id, (draft) => {
          const e = draft.entities.find((x) => x.id === entity.id)
          if (e && e.state !== WorkflowTypes.BLOCKED_STATE) {
            e.state = WorkflowTypes.BLOCKED_STATE
            e.blockedReason = guardResult.reason
            e.time.updated = Date.now()
            e.time.stateEntered = Date.now()
          }
        })
        await WorkflowRunStore.appendEvent(
          scopeID,
          { id: run.id },
          {
            kind: "entity_blocked",
            entityID: entity.id,
            message: guardResult.reason,
          },
        )
      }
      return { ok: false, reason: guardResult.reason ?? "guard failed" }
    }

    // Commit the submission + state change atomically.
    await WorkflowRunStore.update(scopeID, run.id, (draft) => {
      const e = draft.entities.find((x) => x.id === entity.id)
      if (!e) return
      if (input.submission) e.submissions.push(input.submission)
      e.state = transition.to
      e.blockedReason = undefined
      e.time.updated = Date.now()
      e.time.stateEntered = Date.now()
    })
    if (input.submission) {
      await WorkflowRunStore.appendEvent(
        scopeID,
        { id: run.id },
        {
          kind: "submission_recorded",
          entityID: entity.id,
          seat: input.submission.seat,
          data: { kind: input.submission.kind, verdict: input.submission.verdict },
        },
      )
    }
    const transitionEvent = await WorkflowRunStore.appendEvent(
      scopeID,
      { id: run.id },
      {
        kind: "entity_transitioned",
        entityID: entity.id,
        transitionID: transition.id,
        message: `${transition.from} → ${transition.to}`,
      },
    )

    // Effects run after commit.
    await WorkflowEffects.runAll(
      {
        scopeID,
        runID: run.id,
        entityID: entity.id,
        charter,
        transitionID: transition.id,
        transitionEventID: transitionEvent.id,
      },
      transition.effects,
    )
    return { ok: true }
  }

  /** An intent submitted by a seat (via workflow_submit) or by the boss. */
  export async function submitIntent(input: {
    scopeID: string
    runID: string
    entityID: string
    transitionID: string
    actorSessionID: string
    submission?: WorkflowTypes.Submission
    fromBoss?: boolean
  }): Promise<IntentResult> {
    const run = await WorkflowRunStore.get(input.scopeID, input.runID)
    if (run.status !== "active") return { ok: false, reason: `run is ${run.status}, not active` }

    const entity = run.entities.find((e) => e.id === input.entityID)
    if (!entity) return { ok: false, reason: `unknown entity ${input.entityID}` }

    const charter = await charterFor(run)
    const transition = charter.transitions.find((t) => t.id === input.transitionID)
    if (!transition) return { ok: false, reason: `unknown transition ${input.transitionID}` }
    if (transition.from !== entity.state) {
      return {
        ok: false,
        reason: `transition ${transition.id} starts from '${transition.from}', entity is in '${entity.state}'`,
      }
    }
    if (transition.trigger.kind !== "intent") {
      return { ok: false, reason: `transition ${transition.id} is not an intent transition` }
    }

    // Authorize: the actor's seat must be allowed (boss may drive any intent —
    // it is the control plane and its intents are human-authorized).
    if (!input.fromBoss) {
      const seat = seatOf(run, input.actorSessionID)
      if (!seat) return { ok: false, reason: "actor is not a seat in this run" }
      if (!transition.trigger.allowedSeats.includes(seat.seat)) {
        return { ok: false, reason: `seat '${seat.seat}' may not perform transition ${transition.id}` }
      }
    }

    const applied = await applyTransition({
      scopeID: input.scopeID,
      run,
      charter,
      entity,
      transition,
      submission: input.submission,
      triggerKind: "intent",
    })
    if (!applied.ok) return { ok: false, reason: applied.reason }

    const updated = await WorkflowRunStore.get(input.scopeID, input.runID)
    const updatedEntity = updated.entities.find((e) => e.id === input.entityID)
    // Chain: a freshly-entered state may have event transitions ready.
    await evaluateEventTransitions(input.scopeID, input.runID, input.entityID).catch((error) =>
      log.error("post-intent event evaluation failed", { runID: input.runID, error }),
    )
    return { ok: true, run: updated, entityState: updatedEntity?.state ?? entity.state }
  }

  /**
   * Evaluate every event-triggered transition out of an entity's current state,
   * taking the first whose guards pass. Called by the bridge after a platform
   * fact changes and after an intent transition lands.
   */
  export async function evaluateEventTransitions(scopeID: string, runID: string, entityID: string): Promise<void> {
    const run = await WorkflowRunStore.getOrUndefined(scopeID, runID)
    if (!run || run.status !== "active") return
    const entity = run.entities.find((e) => e.id === entityID)
    if (!entity) return
    const charter = await charterFor(run)

    const candidates = charter.transitions.filter((t) => t.trigger.kind === "event" && t.from === entity.state)
    for (const transition of candidates) {
      const guardCtx: WorkflowGuards.Context = { scopeID, run, entity }
      const guardResult = await WorkflowGuards.evaluateAll(guardCtx, transition.guards)
      if (!guardResult.ok) continue
      const applied = await applyTransition({ scopeID, run, charter, entity, transition, triggerKind: "event" })
      if (applied.ok) {
        // Re-evaluate: the new state may cascade further event transitions.
        await evaluateEventTransitions(scopeID, runID, entityID)
      }
      return
    }
  }

  /** Human (or boss agent) resolves a gate; fire the matching gate transition. */
  export async function resolveGate(input: {
    scopeID: string
    runID: string
    gateInstanceID: string
    resolution: string
    resolvedBy: "human_ui" | "boss_agent"
  }): Promise<WorkflowTypes.Run> {
    const run = await WorkflowRunStore.get(input.scopeID, input.runID)
    const gate = run.gates.find((g) => g.id === input.gateInstanceID)
    if (!gate) throw new WorkflowError.TransitionRejected({ reason: `unknown gate ${input.gateInstanceID}` })
    if (gate.status !== "pending") {
      throw new WorkflowError.TransitionRejected({ reason: `gate ${gate.id} is already ${gate.status}` })
    }
    const charter = await charterFor(run)
    const gateDef = charter.gates.find((g) => g.name === gate.gate)
    if (gateDef && !gateDef.resolutions.includes(input.resolution)) {
      throw new WorkflowError.TransitionRejected({
        reason: `resolution '${input.resolution}' not in [${gateDef.resolutions.join(", ")}]`,
      })
    }

    await WorkflowRunStore.update(input.scopeID, input.runID, (draft) => {
      const g = draft.gates.find((x) => x.id === input.gateInstanceID)
      if (g) {
        g.status = "resolved"
        g.resolution = input.resolution
        g.resolvedBy = input.resolvedBy
        g.time.resolved = Date.now()
      }
    })
    await WorkflowRunStore.appendEvent(
      input.scopeID,
      { id: input.runID },
      {
        kind: "gate_resolved",
        entityID: gate.entityID,
        data: { gate: gate.gate, resolution: input.resolution, resolvedBy: input.resolvedBy },
      },
    )

    // Fire the gate transition(s) for the gated entity.
    if (gate.entityID) {
      const fresh = await WorkflowRunStore.get(input.scopeID, input.runID)
      const entity = fresh.entities.find((e) => e.id === gate.entityID)
      if (entity) {
        const gateTransitions = charter.transitions.filter(
          (t) => t.trigger.kind === "gate" && t.trigger.gate === gate.gate && t.from === entity.state,
        )
        for (const transition of gateTransitions) {
          const applied = await applyTransition({
            scopeID: input.scopeID,
            run: fresh,
            charter,
            entity,
            transition,
            triggerKind: "gate",
          })
          if (applied.ok) {
            await evaluateEventTransitions(input.scopeID, input.runID, gate.entityID)
            break
          }
        }
      }
    }
    return WorkflowRunStore.get(input.scopeID, input.runID)
  }
}
