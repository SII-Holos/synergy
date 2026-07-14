import { Identifier } from "../id/id"
import { Log } from "../util/log"
import { CharterStore } from "./charter-store"
import { WorkflowEffects } from "./effects"
import { WorkflowError } from "./error"
import { WorkflowRunExecutor } from "./executor"
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

  class TransitionAuthorizationConflict extends Error {}

  export type IntentResult = { ok: true; run: WorkflowTypes.Run; entityState: string } | { ok: false; reason: string }

  async function charterFor(run: WorkflowTypes.Run): Promise<WorkflowTypes.Charter> {
    return CharterStore.get(run.scopeID, run.charterRef.id, run.charterRef.version)
  }

  function actorRejection(
    run: WorkflowTypes.Run,
    entity: WorkflowTypes.Entity,
    transition: WorkflowTypes.TransitionDef,
    actor: { sessionID: string; fromBoss: boolean } | undefined,
  ): string | undefined {
    if (!actor) return
    if (actor.fromBoss) {
      return run.bossSessionID === actor.sessionID ? undefined : "Boss session does not own this workflow run"
    }
    const binding = run.seats.find((candidate) => candidate.sessionID === actor.sessionID)
    if (!binding) return "actor is not a seat in this run"
    if (binding.entityID !== entity.id) return "actor seat does not own this entity"
    if (transition.trigger.kind !== "intent" || !transition.trigger.allowedSeats.includes(binding.seat)) {
      return `seat '${binding.seat}' may not perform transition ${transition.id}`
    }
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
    actor?: { sessionID: string; fromBoss: boolean }
    gateResolution?: {
      gateInstanceID: string
      resolution: string
      resolvedBy: "human_ui" | "boss_agent"
    }
  }): Promise<{ ok: true } | { ok: false; reason: string }> {
    return WorkflowRunExecutor.run(input.scopeID, input.run.id, () => applyTransitionLocked(input))
  }

  async function applyTransitionLocked(input: {
    scopeID: string
    run: WorkflowTypes.Run
    charter: WorkflowTypes.Charter
    entity: WorkflowTypes.Entity
    transition: WorkflowTypes.TransitionDef
    submission?: WorkflowTypes.Submission
    triggerKind: "event" | "intent" | "gate"
    actor?: { sessionID: string; fromBoss: boolean }
    gateResolution?: {
      gateInstanceID: string
      resolution: string
      resolvedBy: "human_ui" | "boss_agent"
    }
  }): Promise<{ ok: true } | { ok: false; reason: string }> {
    const { scopeID, charter, transition } = input
    const run = await WorkflowRunStore.getOrUndefined(scopeID, input.run.id)
    if (!run) return { ok: false, reason: `workflow run ${input.run.id} not found` }
    if (run.status !== "active") return { ok: false, reason: `run is ${run.status}, not active` }
    const entity = run.entities.find((candidate) => candidate.id === input.entity.id)
    if (!entity) return { ok: false, reason: `unknown entity ${input.entity.id}` }
    if (entity.state !== transition.from) {
      return {
        ok: false,
        reason: `entity ${entity.id} left state '${transition.from}' before transition ${transition.id} committed`,
      }
    }

    const initialActorRejection = actorRejection(run, entity, transition, input.actor)
    if (initialActorRejection) return { ok: false, reason: initialActorRejection }

    let guardRun = run
    if (input.gateResolution) {
      const projected = structuredClone(run)
      const gate = projected.gates.find((candidate) => candidate.id === input.gateResolution!.gateInstanceID)
      if (!gate || gate.status !== "pending") {
        return { ok: false, reason: `gate ${input.gateResolution.gateInstanceID} is not pending` }
      }
      gate.status = "resolved"
      gate.resolution = input.gateResolution.resolution
      gate.resolvedBy = input.gateResolution.resolvedBy
      gate.time.resolved = Date.now()
      guardRun = projected
    }

    // A submission delivered with the intent is part of the state the guard sees
    // — workflow_submit records the result and clears its own guard in one call.
    const guardEntity = input.submission
      ? { ...entity, submissions: [...entity.submissions, input.submission] }
      : entity
    const guardCtx: WorkflowGuards.Context = { scopeID, run: guardRun, entity: guardEntity }
    const guardResult = await WorkflowGuards.evaluateAll(guardCtx, transition.guards)
    if (!guardResult.ok) {
      if (input.triggerKind === "event" && guardResult.retryable) {
        return { ok: false, reason: guardResult.reason ?? "shared resource unavailable" }
      }
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
      const shouldBlock = !input.gateResolution && (transition.blockOnGuardFail ?? input.triggerKind === "event")
      if (shouldBlock) {
        try {
          await WorkflowRunStore.update(
            scopeID,
            run.id,
            (draft) => {
              const e = draft.entities.find((x) => x.id === entity.id)
              if (!e) return
              const rejection = actorRejection(draft, e, transition, input.actor)
              if (rejection) throw new TransitionAuthorizationConflict(rejection)
              if (e.state !== WorkflowTypes.BLOCKED_STATE) {
                e.state = WorkflowTypes.BLOCKED_STATE
                e.blockedReason = guardResult.reason
                e.time.updated = Date.now()
                e.time.stateEntered = Date.now()
              }
            },
            {
              expectedRunStatus: "active",
              expectedEntityState: { entityID: entity.id, state: transition.from },
            },
          )
        } catch (error) {
          if (error instanceof TransitionAuthorizationConflict) return { ok: false, reason: error.message }
          throw error
        }
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

    // Commit state + pending-effect outbox under CAS on the source state so two
    // concurrent intents cannot both transition the same entity, and a crash
    // after commit still leaves recoverable pending effects.
    const pendingEffectID = Identifier.ascending("workflow_event")
    const transitionEventID = Identifier.ascending("workflow_event")
    let commit: WorkflowRunStore.UpdateResult
    try {
      commit = await WorkflowRunStore.tryUpdate(
        scopeID,
        run.id,
        (draft) => {
          const e = draft.entities.find((x) => x.id === entity.id)
          if (!e) return
          const rejection = actorRejection(draft, e, transition, input.actor)
          if (rejection) throw new TransitionAuthorizationConflict(rejection)
          if (input.gateResolution) {
            const gate = draft.gates.find((candidate) => candidate.id === input.gateResolution!.gateInstanceID)
            if (!gate || gate.status !== "pending" || gate.entityID !== entity.id) {
              throw new WorkflowError.TransitionRejected({
                reason: `gate ${input.gateResolution.gateInstanceID} is no longer pending for entity ${entity.id}`,
              })
            }
            gate.status = "resolved"
            gate.resolution = input.gateResolution.resolution
            gate.resolvedBy = input.gateResolution.resolvedBy
            gate.time.resolved = Date.now()
          }
          if (input.submission) e.submissions.push(input.submission)
          e.state = transition.to
          e.blockedReason = undefined
          e.time.updated = Date.now()
          e.time.stateEntered = Date.now()
          if (transition.effects.length > 0) {
            draft.pendingEffects = draft.pendingEffects ?? []
            draft.pendingEffects.push({
              id: pendingEffectID,
              transitionEventID,
              transitionID: transition.id,
              entityID: entity.id,
              effects: transition.effects,
              nextIndex: 0,
            })
          }
        },
        {
          expectedRunStatus: "active",
          expectedEntityState: { entityID: entity.id, state: transition.from },
        },
      )
    } catch (error) {
      if (error instanceof TransitionAuthorizationConflict) return { ok: false, reason: error.message }
      throw error
    }
    if (!commit.ok) {
      return {
        ok: false,
        reason:
          commit.reason === "conflict"
            ? `entity ${entity.id} left state '${transition.from}' before transition ${transition.id} committed`
            : `workflow run ${run.id} not found`,
      }
    }
    if (input.gateResolution) {
      const gate = run.gates.find((candidate) => candidate.id === input.gateResolution!.gateInstanceID)
      await WorkflowRunStore.appendEvent(
        scopeID,
        { id: run.id },
        {
          kind: "gate_resolved",
          entityID: entity.id,
          data: {
            gate: gate?.gate,
            resolution: input.gateResolution.resolution,
            resolvedBy: input.gateResolution.resolvedBy,
          },
        },
      )
    }
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
    await WorkflowRunStore.appendEvent(
      scopeID,
      { id: run.id },
      {
        id: transitionEventID,
        kind: "entity_transitioned",
        entityID: entity.id,
        transitionID: transition.id,
        message: `${transition.from} → ${transition.to}`,
      },
    )

    // Effects run from the outbox after commit.
    if (transition.effects.length > 0) {
      await WorkflowEffects.runPending(
        {
          scopeID,
          runID: run.id,
          entityID: entity.id,
          charter,
          transitionID: transition.id,
          transitionEventID,
        },
        pendingEffectID,
      )
    }
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
      const seat = run.seats.find((binding) => binding.sessionID === input.actorSessionID)
      if (!seat) return { ok: false, reason: "actor is not a seat in this run" }
      if (seat.entityID !== entity.id) return { ok: false, reason: "actor seat does not own this entity" }
      if (!transition.trigger.allowedSeats.includes(seat.seat)) {
        return { ok: false, reason: `seat '${seat.seat}' may not perform transition ${transition.id}` }
      }
    } else if (run.bossSessionID !== input.actorSessionID) {
      return { ok: false, reason: "Boss session does not own this workflow run" }
    }

    const applied = await applyTransition({
      scopeID: input.scopeID,
      run,
      charter,
      entity,
      transition,
      submission: input.submission,
      triggerKind: "intent",
      actor: { sessionID: input.actorSessionID, fromBoss: input.fromBoss === true },
    })
    if (!applied.ok) return { ok: false, reason: applied.reason }

    // Chain: a freshly-entered state may have event transitions ready.
    await evaluateEventTransitions(input.scopeID, input.runID, input.entityID).catch((error) =>
      log.error("post-intent event evaluation failed", { runID: input.runID, error }),
    )
    // A transition may have freed a seat (e.g. handing off to another seat);
    // give queued/waiting siblings a chance to advance.
    await redrivePending(input.scopeID, input.runID).catch((error) =>
      log.error("post-intent redrive failed", { runID: input.runID, error }),
    )
    const updated = await WorkflowRunStore.get(input.scopeID, input.runID)
    const updatedEntity = updated.entities.find((e) => e.id === input.entityID)
    return { ok: true, run: updated, entityState: updatedEntity?.state ?? entity.state }
  }

  /**
   * Re-evaluate event transitions for every non-terminal, non-blocked entity —
   * used after a transition that may have changed shared resources (a freed seat
   * pool slot, budget). Runs a bounded fixpoint so a single release can drain
   * multiple queued entities that in turn free further resources, without
   * risking an unbounded loop.
   */
  export async function redrivePending(scopeID: string, runID: string): Promise<void> {
    const first = await WorkflowRunStore.getOrUndefined(scopeID, runID)
    if (!first || first.status !== "active") return
    const charter = await charterFor(first)
    const maxPasses = Math.max(1, first.entities.length)
    let previousSignature = ""
    for (let pass = 0; pass < maxPasses; pass++) {
      const run = await WorkflowRunStore.getOrUndefined(scopeID, runID)
      if (!run || run.status !== "active") return
      const signature = run.entities.map((e) => `${e.id}:${e.state}`).join("|")
      if (signature === previousSignature) return // stable — nothing more to do
      previousSignature = signature
      for (const entity of run.entities) {
        if (entity.state === WorkflowTypes.BLOCKED_STATE) continue
        if (WorkflowTypes.isTerminalState(charter, entity.state)) continue
        await evaluateEventTransitions(scopeID, runID, entity.id)
      }
    }
  }

  /**
   * Evaluate every event-triggered transition out of an entity's current state,
   * in Charter order. Each candidate goes through the canonical guard path so
   * its block-or-wait policy is preserved. Called by the bridge after a
   * platform fact changes and after an intent transition lands.
   */
  export async function evaluateEventTransitions(scopeID: string, runID: string, entityID: string): Promise<void> {
    const run = await WorkflowRunStore.getOrUndefined(scopeID, runID)
    if (!run || run.status !== "active") return
    const entity = run.entities.find((e) => e.id === entityID)
    if (!entity) return
    const charter = await charterFor(run)

    const candidates = charter.transitions.filter((t) => t.trigger.kind === "event" && t.from === entity.state)
    for (const transition of candidates) {
      const applied = await applyTransition({ scopeID, run, charter, entity, transition, triggerKind: "event" })
      if (applied.ok) {
        // Re-evaluate: the new state may cascade further event transitions.
        await evaluateEventTransitions(scopeID, runID, entityID)
        return
      }
      const current = await WorkflowRunStore.getOrUndefined(scopeID, runID)
      if (!current || current.status !== "active") return
      const currentEntity = current.entities.find((candidate) => candidate.id === entityID)
      if (!currentEntity || currentEntity.state !== entity.state) return
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
    const transitionedEntityID = await WorkflowRunExecutor.run(input.scopeID, input.runID, async () => {
      return resolveGateLocked(input)
    })
    if (transitionedEntityID) {
      await evaluateEventTransitions(input.scopeID, input.runID, transitionedEntityID)
    }
    await redrivePending(input.scopeID, input.runID).catch(() => undefined)
    return WorkflowRunStore.get(input.scopeID, input.runID)
  }

  async function resolveGateLocked(input: {
    scopeID: string
    runID: string
    gateInstanceID: string
    resolution: string
    resolvedBy: "human_ui" | "boss_agent"
  }): Promise<string> {
    const run = await WorkflowRunStore.get(input.scopeID, input.runID)
    if (run.status !== "active") {
      throw new WorkflowError.TransitionRejected({ reason: `run is ${run.status}, not active` })
    }
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

    if (!gate.entityID) {
      throw new WorkflowError.TransitionRejected({ reason: `gate ${gate.id} is not attached to an entity` })
    }
    const entity = run.entities.find((candidate) => candidate.id === gate.entityID)
    if (!entity) {
      throw new WorkflowError.TransitionRejected({ reason: `gate ${gate.id} references an unknown entity` })
    }
    const gateTransitions = charter.transitions.filter(
      (transition) =>
        transition.trigger.kind === "gate" && transition.trigger.gate === gate.gate && transition.from === entity.state,
    )
    const failures: string[] = []
    for (const transition of gateTransitions) {
      const applied = await applyTransitionLocked({
        scopeID: input.scopeID,
        run,
        charter,
        entity,
        transition,
        triggerKind: "gate",
        gateResolution: {
          gateInstanceID: gate.id,
          resolution: input.resolution,
          resolvedBy: input.resolvedBy,
        },
      })
      if (applied.ok) return gate.entityID
      failures.push(`${transition.id}: ${applied.reason}`)
    }
    throw new WorkflowError.TransitionRejected({
      reason:
        failures.length > 0
          ? `no gate transition accepted '${input.resolution}': ${failures.join("; ")}`
          : `no gate transition matches '${input.resolution}' from state '${entity.state}'`,
    })
  }
}
