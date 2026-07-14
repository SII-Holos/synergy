import { Identifier } from "../id/id"
import { Log } from "../util/log"
import { Session } from "../session"
import { SessionInbox } from "../session/inbox"
import { SessionManager } from "../session/manager"
import { WorkflowGuards } from "./guards"
import { WorkflowHandoff } from "./handoff"
import { WorkflowRunStore } from "./store"
import { WorkflowSeats } from "./seats"
import { WorkflowTypes } from "./types"

/**
 * Effect library. Effects run after an entity's state transition is committed
 * (so a woken session always observes the new state). Each effect is idempotent
 * via a key = `${transitionEventID}:${index}`: before executing, the engine
 * checks the durable run receipt; an already-executed effect is skipped, making
 * replay across recovery safe. The event log is its audit projection. A failed
 * effect blocks the entity and notifies the boss — failures are never silent.
 */
export namespace WorkflowEffects {
  const log = Log.create({ service: "workflow.effects" })

  export interface Context {
    scopeID: string
    runID: string
    entityID: string
    charter: WorkflowTypes.Charter
    transitionID: string
    transitionEventID: string
    effectIndex?: number
  }

  export type Effect = (ctx: Context, args: Record<string, unknown>) => Promise<void>

  const registry = new Map<string, Effect>()
  const bossNoticeDeliveries = new Map<string, Promise<void>>()

  export function register(name: string, effect: Effect): void {
    registry.set(name, effect)
  }

  export function has(name: string): boolean {
    return registry.has(name)
  }

  export function names(): string[] {
    return [...registry.keys()]
  }

  /**
   * Drain a pending-effect outbox entry. Safe after crash recovery because each
   * effect is keyed and skipped once its durable receipt is recorded.
   */
  export async function runPending(ctx: Context, pendingEffectID: string): Promise<void> {
    const run = await WorkflowRunStore.get(ctx.scopeID, ctx.runID)
    if (run.status !== "active") return
    const pending = (run.pendingEffects ?? []).find((item) => item.id === pendingEffectID)
    if (!pending) return
    for (let index = pending.nextIndex; index < pending.effects.length; index++) {
      if ((await WorkflowRunStore.get(ctx.scopeID, ctx.runID)).status !== "active") return
      const outcome = await runOne(ctx, pending.effects, index)
      if (outcome === "inactive") return
      await WorkflowRunStore.update(
        ctx.scopeID,
        ctx.runID,
        (draft) => {
          const item = (draft.pendingEffects ?? []).find((entry) => entry.id === pendingEffectID)
          if (!item) return
          if (outcome === "completed") item.nextIndex = index + 1
          if (outcome !== "completed" || item.nextIndex >= item.effects.length) {
            draft.pendingEffects = (draft.pendingEffects ?? []).filter((entry) => entry.id !== pendingEffectID)
          }
        },
        { expectedRunStatus: "active" },
      )
      if (outcome !== "completed") return
    }
    await WorkflowRunStore.update(
      ctx.scopeID,
      ctx.runID,
      (draft) => {
        draft.pendingEffects = (draft.pendingEffects ?? []).filter((entry) => entry.id !== pendingEffectID)
      },
      { expectedRunStatus: "active" },
    )
  }

  type EffectOutcome = "completed" | "failed" | "deferred" | "inactive"

  class DeferredEffect extends Error {}

  async function runOne(ctx: Context, refs: WorkflowTypes.EffectRef[], index: number): Promise<EffectOutcome> {
    const ref = refs[index]
    const effectKey = `${ctx.transitionEventID}:${index}`
    if (await WorkflowRunStore.effectAlreadyExecuted(ctx.scopeID, ctx.runID, effectKey)) return "completed"

    const effect = registry.get(ref.name)
    if (!effect) {
      await blockEntity(ctx, `unknown effect '${ref.name}'`)
      return "failed"
    }
    try {
      await effect({ ...ctx, effectIndex: index }, ref.args)
      await WorkflowRunStore.update(
        ctx.scopeID,
        ctx.runID,
        (draft) => {
          draft.effectReceipts = draft.effectReceipts ?? {}
          draft.effectReceipts[effectKey] = Date.now()
        },
        { expectedRunStatus: "active" },
      )
    } catch (error) {
      if (error instanceof DeferredEffect) return "deferred"
      const current = await WorkflowRunStore.getOrUndefined(ctx.scopeID, ctx.runID)
      if (current?.status !== "active") return "inactive"
      log.error("effect failed", { runID: ctx.runID, effect: ref.name, error })
      await WorkflowRunStore.appendEvent(
        ctx.scopeID,
        { id: ctx.runID },
        {
          id: effectEventID(ctx, "failed"),
          kind: "effect_failed",
          entityID: ctx.entityID,
          transitionID: ctx.transitionID,
          message: `${ref.name}: ${error instanceof Error ? error.message : String(error)}`,
          data: { effectKey },
        },
      )
      await blockEntity(ctx, `effect '${ref.name}' failed: ${error instanceof Error ? error.message : String(error)}`)
      return "failed"
    }
    await WorkflowRunStore.appendEvent(
      ctx.scopeID,
      { id: ctx.runID },
      {
        id: effectEventID(ctx, "executed"),
        kind: "effect_executed",
        entityID: ctx.entityID,
        transitionID: ctx.transitionID,
        message: ref.name,
        data: { effectKey },
      },
    ).catch((error) => log.error("effect receipt audit failed", { runID: ctx.runID, effect: ref.name, error }))
    return "completed"
  }

  async function blockEntity(ctx: Context, reason: string): Promise<void> {
    await WorkflowRunStore.update(
      ctx.scopeID,
      ctx.runID,
      (draft) => {
        const entity = draft.entities.find((e) => e.id === ctx.entityID)
        if (entity && entity.state !== WorkflowTypes.BLOCKED_STATE) {
          entity.state = WorkflowTypes.BLOCKED_STATE
          entity.blockedReason = reason
          entity.time.updated = Date.now()
          entity.time.stateEntered = Date.now()
        }
      },
      { expectedRunStatus: "active" },
    )
    await WorkflowRunStore.appendEvent(
      ctx.scopeID,
      { id: ctx.runID },
      {
        id: effectEventID(ctx, "blocked"),
        kind: "entity_blocked",
        entityID: ctx.entityID,
        message: reason,
      },
    )
    await deliverBossNotice(
      ctx.scopeID,
      ctx.runID,
      `Entity ${ctx.entityID} is blocked: ${reason}`,
      effectBusinessID("wfn_block", ctx),
    )
  }

  // --- Shared helpers ------------------------------------------------------

  async function currentEntity(ctx: Context): Promise<WorkflowTypes.Entity> {
    const run = await WorkflowRunStore.get(ctx.scopeID, ctx.runID)
    const entity = run.entities.find((e) => e.id === ctx.entityID)
    if (!entity) throw new Error(`entity ${ctx.entityID} not found`)
    return entity
  }

  function argString(args: Record<string, unknown>, key: string): string | undefined {
    const value = args[key]
    return typeof value === "string" ? value : undefined
  }

  function resolveEntityArg(
    value: string | undefined,
    entity: WorkflowTypes.Entity,
    run: WorkflowTypes.Run,
  ): string | undefined {
    if (value === undefined) return undefined
    return WorkflowGuards.resolveArg(value, { scopeID: run.scopeID, run, entity })
  }

  function effectBusinessID(prefix: string, ctx: Context): string {
    return `${prefix}_${ctx.transitionEventID}_${ctx.effectIndex ?? 0}`
  }

  function effectEventID(ctx: Context, suffix: string): string {
    const transition = ctx.transitionEventID.startsWith("wfv_")
      ? ctx.transitionEventID.slice("wfv_".length)
      : ctx.transitionEventID
    return `wfv_${transition}_${ctx.effectIndex ?? 0}_${suffix}`
  }

  async function deliverBossNotice(scopeID: string, runID: string, message: string, noticeID: string): Promise<void> {
    const run = await WorkflowRunStore.getOrUndefined(scopeID, runID)
    if (!run) return
    const key = `${run.bossSessionID}:${noticeID}`
    const active = bossNoticeDeliveries.get(key)
    if (active) return active
    const delivery = deliverBossNoticeOnce(run, message, noticeID).finally(() => bossNoticeDeliveries.delete(key))
    bossNoticeDeliveries.set(key, delivery)
    return delivery
  }

  async function deliverBossNoticeOnce(run: WorkflowTypes.Run, message: string, noticeID: string): Promise<void> {
    const pending = (await SessionInbox.list(run.bossSessionID)).some(
      (item) => workflowNoticeID(item.message?.metadata) === noticeID,
    )
    const materialized = pending
      ? false
      : (await Session.messages({ sessionID: run.bossSessionID })).some(
          (entry) => entry.info.role === "user" && workflowNoticeID(entry.info.metadata) === noticeID,
        )
    if (!pending && !materialized) {
      await SessionInbox.deliver({
        sessionID: run.bossSessionID,
        mode: "steer",
        message: {
          role: "user",
          origin: { type: "system", detail: "workflow_boss_notice" },
          visible: true,
          parts: [
            {
              id: Identifier.ascending("part"),
              type: "text",
              text: `[workflow ${run.title}] ${message}`,
              origin: "system",
            },
          ],
          summary: { title: `Workflow update: ${run.title}` },
          metadata: { workflowRun: { runID: run.id, noticeID } },
        },
      })
    }
    if (!SessionManager.isRunning(run.bossSessionID)) SessionManager.scheduleWake(run.bossSessionID, noticeID)
  }

  function workflowNoticeID(metadata: unknown): string | undefined {
    if (!metadata || typeof metadata !== "object") return undefined
    const workflow = (metadata as Record<string, unknown>).workflowRun
    if (!workflow || typeof workflow !== "object") return undefined
    const noticeID = (workflow as Record<string, unknown>).noticeID
    return typeof noticeID === "string" ? noticeID : undefined
  }

  interface SeatClaim {
    instance: number
    previous?: { seat: string; instance: number }
    previousReleaseDeferred: boolean
  }

  async function claimSeat(ctx: Context, seat: string): Promise<SeatClaim | undefined> {
    let claim: SeatClaim | undefined
    await WorkflowRunStore.update(
      ctx.scopeID,
      ctx.runID,
      (draft) => {
        const entity = draft.entities.find((item) => item.id === ctx.entityID)
        if (!entity) return

        const owned =
          entity.assignedSeat?.seat === seat ? WorkflowSeats.find(draft, seat, entity.assignedSeat.instance) : undefined
        const instance =
          owned?.entityID === entity.id
            ? owned.instance
            : WorkflowSeats.pickInstance(draft, ctx.charter, seat, entity.affinityKey)
        if (instance === undefined) return

        const target = WorkflowSeats.find(draft, seat, instance)
        if (!target || (target.entityID && target.entityID !== entity.id)) return

        const previous = entity.assignedSeat
        const changesSeat = !!previous && (previous.seat !== seat || previous.instance !== instance)
        let previousReleaseDeferred = false
        if (changesSeat && previous) {
          const previousBinding = WorkflowSeats.find(draft, previous.seat, previous.instance)
          if (previousBinding?.entityID === entity.id) {
            previousReleaseDeferred = !!previousBinding.sessionID && SessionManager.isRunning(previousBinding.sessionID)
            if (previousReleaseDeferred) {
              previousBinding.status = "waiting"
            } else {
              previousBinding.entityID = undefined
              previousBinding.status = previousBinding.sessionID ? "idle" : "unbound"
            }
          }
        }

        target.entityID = entity.id
        target.status = "waiting"
        target.lastEntityIDs = [entity.id, ...target.lastEntityIDs.filter((id) => id !== entity.id)].slice(0, 5)
        entity.assignedSeat = { seat, instance }
        if (target.sessionID) entity.bindings.seatSessionID = target.sessionID
        entity.time.updated = Date.now()
        claim = { instance, previous: changesSeat ? previous : undefined, previousReleaseDeferred }
      },
      { expectedRunStatus: "active" },
    )
    return claim
  }

  async function releaseFailedClaim(ctx: Context, seat: string, instance: number): Promise<void> {
    await WorkflowRunStore.update(
      ctx.scopeID,
      ctx.runID,
      (draft) => {
        const binding = WorkflowSeats.find(draft, seat, instance)
        const entity = draft.entities.find((item) => item.id === ctx.entityID)
        if (binding?.entityID === ctx.entityID) {
          binding.entityID = undefined
          binding.status = binding.sessionID ? "idle" : "unbound"
        }
        if (entity?.assignedSeat?.seat === seat && entity.assignedSeat.instance === instance) {
          entity.assignedSeat = undefined
          entity.time.updated = Date.now()
        }
      },
      { expectedRunStatus: "active" },
    )
  }

  async function deferForUnavailableSeat(ctx: Context, seat: string): Promise<never> {
    const transition = ctx.charter.transitions.find((item) => item.id === ctx.transitionID)
    await WorkflowRunStore.update(
      ctx.scopeID,
      ctx.runID,
      (draft) => {
        const entity = draft.entities.find((item) => item.id === ctx.entityID)
        if (!entity || !transition || entity.state !== transition.to) return
        entity.state = transition.from
        entity.blockedReason = undefined
        entity.time.updated = Date.now()
        entity.time.stateEntered = Date.now()
      },
      { expectedRunStatus: "active" },
    )
    await WorkflowRunStore.appendEvent(
      ctx.scopeID,
      { id: ctx.runID },
      {
        kind: "guard_failed",
        entityID: ctx.entityID,
        transitionID: ctx.transitionID,
        message: `seat_available: no free instance of seat '${seat}' after atomic reservation`,
      },
    )
    throw new DeferredEffect(`no free instance of seat '${seat}'`)
  }

  // --- Built-in effects ----------------------------------------------------

  register("assign_entity", async (ctx, args) => {
    const seat = argString(args, "seat")
    if (!seat) throw new Error("assign_entity requires 'seat'")
    const claim = await claimSeat(ctx, seat)
    if (!claim) {
      log.info("no idle seat instance, entity queued", { runID: ctx.runID, seat, entityID: ctx.entityID })
      return deferForUnavailableSeat(ctx, seat)
    }

    let sessionID: string
    try {
      sessionID = await WorkflowSeats.ensureSession(ctx.scopeID, ctx.runID, seat, claim.instance)
      await WorkflowRunStore.update(
        ctx.scopeID,
        ctx.runID,
        (draft) => {
          const entity = draft.entities.find((item) => item.id === ctx.entityID)
          const binding = WorkflowSeats.find(draft, seat, claim.instance)
          if (entity && binding?.entityID === ctx.entityID) {
            entity.bindings.seatSessionID = sessionID
            entity.time.updated = Date.now()
          }
        },
        { expectedRunStatus: "active" },
      )
      await WorkflowSeats.prepareWorktree(ctx.scopeID, ctx.runID, seat, claim.instance, ctx.entityID)
    } catch (error) {
      await releaseFailedClaim(ctx, seat, claim.instance)
      throw error
    }
    await WorkflowRunStore.appendEvent(
      ctx.scopeID,
      { id: ctx.runID },
      {
        id: effectEventID(ctx, "seat_assigned"),
        kind: "seat_assigned",
        entityID: ctx.entityID,
        seat,
        data: { instance: claim.instance, sessionID },
      },
    )
  })

  register("ensure_seat_session", async (ctx, args) => {
    const seat = argString(args, "seat")
    if (!seat) throw new Error("ensure_seat_session requires 'seat'")
    const run = await WorkflowRunStore.get(ctx.scopeID, ctx.runID)
    const entity = run.entities.find((e) => e.id === ctx.entityID)
    const instance = entity?.assignedSeat?.seat === seat ? entity.assignedSeat.instance : 0
    await WorkflowSeats.ensureSession(ctx.scopeID, ctx.runID, seat, instance)
  })

  register("send_handoff", async (ctx, args) => {
    const seat = argString(args, "seat")
    const task = argString(args, "task") ?? "Continue this entity's work."
    const expected = (argString(args, "expectedSubmission") ??
      "deliverable") as WorkflowHandoff.Info["expectedSubmission"]
    const acceptance = Array.isArray(args.acceptance) ? (args.acceptance as string[]) : []
    const includeLastSubmission = args.includeLastSubmission === true

    const run = await WorkflowRunStore.get(ctx.scopeID, ctx.runID)
    let entity = run.entities.find((e) => e.id === ctx.entityID)
    if (!entity) throw new Error("entity not found")

    const targetSeat = seat ?? entity.assignedSeat?.seat
    if (!targetSeat) throw new Error("send_handoff: no target seat")
    const claim = await claimSeat(ctx, targetSeat)
    if (!claim) return deferForUnavailableSeat(ctx, targetSeat)

    const instance = claim.instance
    let sessionID: string
    try {
      sessionID = await WorkflowSeats.ensureSession(ctx.scopeID, ctx.runID, targetSeat, instance)
      await WorkflowRunStore.update(
        ctx.scopeID,
        ctx.runID,
        (draft) => {
          const current = draft.entities.find((item) => item.id === ctx.entityID)
          const binding = WorkflowSeats.find(draft, targetSeat, instance)
          if (current && binding?.entityID === ctx.entityID) {
            current.bindings.seatSessionID = sessionID
            current.time.updated = Date.now()
          }
        },
        { expectedRunStatus: "active" },
      )
      await WorkflowSeats.prepareWorktree(ctx.scopeID, ctx.runID, targetSeat, instance, ctx.entityID)
    } catch (error) {
      await releaseFailedClaim(ctx, targetSeat, instance)
      throw error
    }

    entity = (await WorkflowRunStore.get(ctx.scopeID, ctx.runID)).entities.find((item) => item.id === ctx.entityID)
    if (!entity) throw new Error("entity not found")

    const contextRefs: WorkflowHandoff.ContextRef[] = []
    if (entity.bindings.blueprintNoteID) {
      contextRefs.push({ kind: "note", ref: entity.bindings.blueprintNoteID, hint: "blueprint" })
    }
    if (entity.bindings.issueRef) contextRefs.push({ kind: "file", ref: entity.bindings.issueRef, hint: "issue" })
    if (includeLastSubmission) {
      const last = entity.submissions.at(-1)
      if (last?.sessionID) contextRefs.push({ kind: "session", ref: last.sessionID, hint: "prior work / review" })
    }

    const taskText = includeLastSubmission
      ? `${task}\n\nMost recent submission: ${entity.submissions.at(-1)?.summary ?? "(none)"}`
      : task

    const handoff: WorkflowHandoff.Info = {
      id: `wfh_${ctx.transitionEventID}_${ctx.effectIndex ?? 0}`,
      runID: ctx.runID,
      entityID: ctx.entityID,
      toSeat: { seat: targetSeat, instance },
      task: taskText,
      acceptance,
      contextRefs,
      expectedSubmission: expected,
    }

    await WorkflowRunStore.update(
      ctx.scopeID,
      ctx.runID,
      (draft) => {
        const e = draft.entities.find((x) => x.id === ctx.entityID)
        if (e) {
          e.pendingHandoffID = handoff.id
          e.bindings.seatSessionID = sessionID
          e.time.updated = Date.now()
        }
      },
      { expectedRunStatus: "active" },
    )
    if (claim.previous) {
      await WorkflowRunStore.appendEvent(
        ctx.scopeID,
        { id: ctx.runID },
        {
          id: effectEventID(ctx, "previous_seat_released"),
          kind: "seat_released",
          entityID: ctx.entityID,
          seat: claim.previous.seat,
          data: { instance: claim.previous.instance, deferredUntilIdle: claim.previousReleaseDeferred },
        },
      )
    }
    const delivery = await WorkflowHandoff.deliver(ctx.scopeID, sessionID, handoff, entity, {
      wake: !claim.previousReleaseDeferred,
    })
    await WorkflowRunStore.update(
      ctx.scopeID,
      ctx.runID,
      (draft) => {
        const binding = WorkflowSeats.find(draft, targetSeat, instance)
        if (binding?.entityID === ctx.entityID) {
          binding.status = "waiting"
        }
      },
      { expectedRunStatus: "active" },
    )
    await WorkflowRunStore.appendEvent(
      ctx.scopeID,
      { id: ctx.runID },
      {
        id: effectEventID(ctx, "handoff_sent"),
        kind: "handoff_sent",
        entityID: ctx.entityID,
        seat: targetSeat,
        data: { handoffID: handoff.id, sessionID, itemID: delivery.itemID, messageID: delivery.messageID },
      },
    )
  })

  register("start_blueprint_loop", async (ctx, args) => {
    const run = await WorkflowRunStore.get(ctx.scopeID, ctx.runID)
    const entity = run.entities.find((e) => e.id === ctx.entityID)
    if (!entity) throw new Error("entity not found")
    const noteID = resolveEntityArg(argString(args, "noteID") ?? "$entity.bindings.blueprintNoteID", entity, run)
    if (!noteID) throw new Error("start_blueprint_loop requires a blueprint noteID binding")
    const sessionID = entity.bindings.seatSessionID
    if (!sessionID) throw new Error("start_blueprint_loop requires an assigned seat session")

    const { BlueprintLoopService } = await import("../blueprint")
    const loop = await BlueprintLoopService.createAndStart({
      id: effectBusinessID("bll", ctx),
      noteID,
      title: entity.title,
      description: entity.description,
      sessionID,
      runMode: "current",
      source: "workflow",
    })
    await WorkflowRunStore.update(
      ctx.scopeID,
      ctx.runID,
      (draft) => {
        const e = draft.entities.find((x) => x.id === ctx.entityID)
        if (e) {
          e.bindings.loopID = loop.id
          e.time.updated = Date.now()
        }
      },
      { expectedRunStatus: "active" },
    )
  })

  register("create_worktree", async (ctx) => {
    const run = await WorkflowRunStore.get(ctx.scopeID, ctx.runID)
    const entity = run.entities.find((e) => e.id === ctx.entityID)
    const sessionID = entity?.bindings.seatSessionID
    if (!sessionID) throw new Error("create_worktree requires an assigned seat session")
    // Isolate the workspace switch so it does not leak into the Boss's live turn
    // (see WorkflowSeats.createSeatWorktree). We need the created worktree id, so
    // create unbound here and bind separately inside the seat's own context.
    await WorkflowSeats.createSeatWorktree(sessionID, `wf-${ctx.entityID}`.slice(0, 60))
    const { Session } = await import("../session")
    const seatSession = await Session.get(sessionID)
    const workspace = seatSession.workspace as Record<string, unknown> | undefined
    await WorkflowRunStore.update(
      ctx.scopeID,
      ctx.runID,
      (draft) => {
        const e = draft.entities.find((x) => x.id === ctx.entityID)
        if (e && workspace) {
          if (typeof workspace.worktreeID === "string") e.bindings.worktreeID = workspace.worktreeID
          if (typeof workspace.resolvedBaseCommit === "string") e.bindings.baseCommit = workspace.resolvedBaseCommit
          e.time.updated = Date.now()
        }
      },
      { expectedRunStatus: "active" },
    )
  })

  register("spawn_contractor", async (ctx, args) => {
    const agent = argString(args, "agent")
    if (!agent) throw new Error("spawn_contractor requires 'agent'")
    const prompt = argString(args, "prompt") ?? "Perform the requested independent task and report a concise result."
    const run = await WorkflowRunStore.get(ctx.scopeID, ctx.runID)
    const boss = run.bossSessionID
    const correlationID = effectBusinessID("workflow_contractor", ctx)
    const existing = (await Session.children(boss)).find(
      (child) => child.cortex?.owner?.kind === "workflow_run" && child.cortex.owner.correlationID === correlationID,
    )
    let taskID = existing?.cortex?.taskID
    if (!taskID) {
      const { Cortex } = await import("../cortex")
      const task = await Cortex.launch({
        description: `Contractor for ${ctx.entityID}`,
        prompt,
        agent,
        executionRole: "delegated_subagent",
        parentSessionID: boss,
        parentMessageID: Identifier.ascending("message"),
        visibility: "hidden",
        owner: {
          kind: "workflow_run",
          runID: ctx.runID,
          entityID: ctx.entityID,
          correlationID,
        },
      }).catch((error) => {
        throw new Error(`contractor launch failed: ${error instanceof Error ? error.message : String(error)}`)
      })
      taskID = task.id
    }
    await WorkflowRunStore.appendEvent(
      ctx.scopeID,
      { id: ctx.runID },
      {
        id: effectEventID(ctx, "contractor_spawned"),
        kind: "contractor_spawned",
        entityID: ctx.entityID,
        data: { taskID, agent, correlationID },
      },
    )
  })

  register("open_gate", async (ctx, args) => {
    const gateName = argString(args, "gate")
    if (!gateName) throw new Error("open_gate requires 'gate'")
    const gateDef = ctx.charter.gates.find((g) => g.name === gateName)
    if (!gateDef) throw new Error(`charter has no gate '${gateName}'`)
    const entity = await currentEntity(ctx)
    const context = buildGateContext(entity)
    const gateID = effectBusinessID("wfg", ctx)
    await WorkflowRunStore.update(
      ctx.scopeID,
      ctx.runID,
      (draft) => {
        if (draft.gates.some((gate) => gate.id === gateID)) return
        draft.gates.push({
          id: gateID,
          gate: gateName,
          entityID: ctx.entityID,
          transitionID: ctx.transitionID,
          status: "pending",
          context,
          time: { created: Date.now() },
        })
      },
      { expectedRunStatus: "active" },
    )
    await WorkflowRunStore.appendEvent(
      ctx.scopeID,
      { id: ctx.runID },
      {
        id: effectEventID(ctx, "gate_opened"),
        kind: "gate_opened",
        entityID: ctx.entityID,
        data: { gate: gateName, gateID },
      },
    )
    await deliverBossNotice(
      ctx.scopeID,
      ctx.runID,
      `Gate "${gateDef.title}" awaits your decision for "${entity.title}". Resolutions: ${gateDef.resolutions.join(", ")}.`,
      effectBusinessID("wfn_gate", ctx),
    )
  })

  register("notify_boss", async (ctx, args) => {
    const message = argString(args, "message") ?? "Workflow update."
    await deliverBossNotice(ctx.scopeID, ctx.runID, message, effectBusinessID("wfn", ctx))
  })

  register("set_binding", async (ctx, args) => {
    const key = argString(args, "key")
    if (!key) throw new Error("set_binding requires 'key'")
    const run = await WorkflowRunStore.get(ctx.scopeID, ctx.runID)
    const entity = run.entities.find((e) => e.id === ctx.entityID)
    if (!entity) throw new Error("entity not found")
    const value = resolveEntityArg(argString(args, "value"), entity, run) ?? argString(args, "value")
    await WorkflowRunStore.update(
      ctx.scopeID,
      ctx.runID,
      (draft) => {
        const e = draft.entities.find((x) => x.id === ctx.entityID)
        if (e && value !== undefined) {
          e.bindings[key] = value
          e.time.updated = Date.now()
        }
      },
      { expectedRunStatus: "active" },
    )
  })

  register("release_seat", async (ctx) => {
    const before = await WorkflowRunStore.get(ctx.scopeID, ctx.runID)
    const beforeEntity = before.entities.find((entity) => entity.id === ctx.entityID)
    const released = beforeEntity?.assignedSeat
    if (!released) return
    const beforeBinding = WorkflowSeats.find(before, released.seat, released.instance)
    const deferredUntilIdle = !!beforeBinding?.sessionID && SessionManager.isRunning(beforeBinding.sessionID)

    await WorkflowRunStore.update(
      ctx.scopeID,
      ctx.runID,
      (draft) => {
        const entity = draft.entities.find((e) => e.id === ctx.entityID)
        const seat = entity?.assignedSeat
        if (seat) {
          const binding = WorkflowSeats.find(draft, seat.seat, seat.instance)
          if (binding?.entityID === ctx.entityID) {
            if (deferredUntilIdle) {
              binding.status = "waiting"
            } else {
              binding.entityID = undefined
              binding.status = binding.sessionID ? "idle" : "unbound"
            }
          }
          entity.assignedSeat = undefined
          entity.time.updated = Date.now()
        }
      },
      { expectedRunStatus: "active" },
    )
    await WorkflowRunStore.appendEvent(
      ctx.scopeID,
      { id: ctx.runID },
      {
        id: effectEventID(ctx, "seat_released"),
        kind: "seat_released",
        entityID: ctx.entityID,
        seat: released.seat,
        data: { instance: released.instance, deferredUntilIdle },
      },
    )
  })

  register("archive_seat_sessions", async (ctx) => {
    const run = await WorkflowRunStore.get(ctx.scopeID, ctx.runID)
    const { Session } = await import("../session")
    for (const binding of run.seats) {
      if (!binding.sessionID) continue
      await Session.update(binding.sessionID, (draft) => {
        draft.time.archived = Date.now()
      }).catch(() => undefined)
    }
  })

  function buildGateContext(entity: WorkflowTypes.Entity): string {
    const lines = [`Entity: ${entity.title} (${entity.id})`, `State: ${entity.state}`]
    if (Object.keys(entity.bindings).length > 0) {
      lines.push("Bindings:")
      for (const [k, v] of Object.entries(entity.bindings)) lines.push(`  ${k}: ${v}`)
    }
    if (entity.submissions.length > 0) {
      lines.push("Submissions:")
      for (const s of entity.submissions) {
        lines.push(`  [${s.kind}${s.verdict ? `/${s.verdict}` : ""}] ${s.summary}`)
      }
    }
    return lines.join("\n")
  }
}
