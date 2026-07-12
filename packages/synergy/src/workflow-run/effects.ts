import { Identifier } from "../id/id"
import { Log } from "../util/log"
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
 * checks the event log; an already-executed effect is skipped, making replay
 * across recovery safe. A failed effect blocks the entity and notifies the boss
 * — failures are never silent.
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
  }

  export type Effect = (ctx: Context, args: Record<string, unknown>) => Promise<void>

  const registry = new Map<string, Effect>()

  export function register(name: string, effect: Effect): void {
    registry.set(name, effect)
  }

  export function has(name: string): boolean {
    return registry.has(name)
  }

  export function names(): string[] {
    return [...registry.keys()]
  }

  /** Execute a transition's effects in order, with idempotency + failure blocking. */
  export async function runAll(ctx: Context, refs: WorkflowTypes.EffectRef[]): Promise<void> {
    for (let index = 0; index < refs.length; index++) {
      const advanced = await runOne(ctx, refs, index)
      if (!advanced) return
    }
  }

  /**
   * Drain a pending-effect outbox entry. Safe after crash recovery because each
   * effect is keyed and skipped once `effect_executed` is recorded.
   */
  export async function runPending(ctx: Context, pendingEffectID: string): Promise<void> {
    const run = await WorkflowRunStore.get(ctx.scopeID, ctx.runID)
    const pending = (run.pendingEffects ?? []).find((item) => item.id === pendingEffectID)
    if (!pending) return
    for (let index = pending.nextIndex; index < pending.effects.length; index++) {
      const advanced = await runOne(ctx, pending.effects, index)
      await WorkflowRunStore.update(ctx.scopeID, ctx.runID, (draft) => {
        const item = (draft.pendingEffects ?? []).find((entry) => entry.id === pendingEffectID)
        if (!item) return
        if (advanced) item.nextIndex = index + 1
        if (!advanced || item.nextIndex >= item.effects.length) {
          draft.pendingEffects = (draft.pendingEffects ?? []).filter((entry) => entry.id !== pendingEffectID)
        }
      })
      if (!advanced) return
    }
    await WorkflowRunStore.update(ctx.scopeID, ctx.runID, (draft) => {
      draft.pendingEffects = (draft.pendingEffects ?? []).filter((entry) => entry.id !== pendingEffectID)
    })
  }

  async function runOne(ctx: Context, refs: WorkflowTypes.EffectRef[], index: number): Promise<boolean> {
    const ref = refs[index]
    const effectKey = `${ctx.transitionEventID}:${index}`
    if (await WorkflowRunStore.effectAlreadyExecuted(ctx.scopeID, ctx.runID, effectKey)) return true

    const effect = registry.get(ref.name)
    if (!effect) {
      await blockEntity(ctx, `unknown effect '${ref.name}'`)
      return false
    }
    try {
      await effect(ctx, ref.args)
      await WorkflowRunStore.appendEvent(
        ctx.scopeID,
        { id: ctx.runID },
        {
          kind: "effect_executed",
          entityID: ctx.entityID,
          transitionID: ctx.transitionID,
          message: ref.name,
          data: { effectKey },
        },
      )
      return true
    } catch (error) {
      log.error("effect failed", { runID: ctx.runID, effect: ref.name, error })
      await WorkflowRunStore.appendEvent(
        ctx.scopeID,
        { id: ctx.runID },
        {
          kind: "effect_failed",
          entityID: ctx.entityID,
          transitionID: ctx.transitionID,
          message: `${ref.name}: ${error instanceof Error ? error.message : String(error)}`,
          data: { effectKey },
        },
      )
      await blockEntity(ctx, `effect '${ref.name}' failed: ${error instanceof Error ? error.message : String(error)}`)
      return false
    }
  }

  async function blockEntity(ctx: Context, reason: string): Promise<void> {
    await WorkflowRunStore.update(ctx.scopeID, ctx.runID, (draft) => {
      const entity = draft.entities.find((e) => e.id === ctx.entityID)
      if (entity && entity.state !== WorkflowTypes.BLOCKED_STATE) {
        entity.state = WorkflowTypes.BLOCKED_STATE
        entity.blockedReason = reason
        entity.time.updated = Date.now()
        entity.time.stateEntered = Date.now()
      }
    })
    await WorkflowRunStore.appendEvent(
      ctx.scopeID,
      { id: ctx.runID },
      {
        kind: "entity_blocked",
        entityID: ctx.entityID,
        message: reason,
      },
    )
    await deliverBossNotice(ctx.scopeID, ctx.runID, `Entity ${ctx.entityID} is blocked: ${reason}`)
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

  async function deliverBossNotice(scopeID: string, runID: string, message: string): Promise<void> {
    const run = await WorkflowRunStore.getOrUndefined(scopeID, runID)
    if (!run) return
    const { SessionInbox } = await import("../session/inbox")
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
          } as any,
        ],
        summary: { title: `Workflow update: ${run.title}` },
        metadata: { workflowRun: { runID } },
      },
    }).catch(() => undefined)
    if (!SessionManager.isRunning(run.bossSessionID)) {
      SessionManager.scheduleWake(run.bossSessionID, "workflow_boss_notice")
    }
  }

  // --- Built-in effects ----------------------------------------------------

  register("assign_entity", async (ctx, args) => {
    const seat = argString(args, "seat")
    if (!seat) throw new Error("assign_entity requires 'seat'")
    const run = await WorkflowRunStore.get(ctx.scopeID, ctx.runID)
    const entity = run.entities.find((e) => e.id === ctx.entityID)
    if (!entity) throw new Error("entity not found")

    const instance = WorkflowSeats.pickInstance(run, ctx.charter, seat, entity.affinityKey)
    if (instance === undefined) {
      // Pool fully occupied — leave the entity where it is; a later seat_released
      // event re-evaluates queued entities.
      log.info("no idle seat instance, entity queued", { runID: ctx.runID, seat, entityID: ctx.entityID })
      return
    }

    const sessionID = await WorkflowSeats.ensureSession(ctx.scopeID, ctx.runID, seat, instance)
    await WorkflowRunStore.update(ctx.scopeID, ctx.runID, (draft) => {
      const e = draft.entities.find((x) => x.id === ctx.entityID)
      const binding = WorkflowSeats.find(draft, seat, instance)
      if (e) {
        e.assignedSeat = { seat, instance }
        e.bindings.seatSessionID = sessionID
        e.time.updated = Date.now()
      }
      if (binding) {
        // Allocation only; live status is projected from Cortex/Session.
        binding.entityID = ctx.entityID
        binding.lastEntityIDs = [ctx.entityID, ...binding.lastEntityIDs].slice(0, 5)
        binding.status = "waiting"
      }
    })
    await WorkflowRunStore.appendEvent(
      ctx.scopeID,
      { id: ctx.runID },
      {
        kind: "seat_assigned",
        entityID: ctx.entityID,
        seat,
        data: { instance, sessionID },
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
    const entity = run.entities.find((e) => e.id === ctx.entityID)
    if (!entity) throw new Error("entity not found")

    const targetSeat = seat ?? entity.assignedSeat?.seat
    if (!targetSeat) throw new Error("send_handoff: no target seat")
    let instance = entity.assignedSeat?.seat === targetSeat ? entity.assignedSeat.instance : undefined
    if (instance === undefined) {
      instance = WorkflowSeats.pickInstance(run, ctx.charter, targetSeat, entity.affinityKey)
      if (instance === undefined) throw new Error(`send_handoff: no idle instance of seat '${targetSeat}'`)
    }
    const sessionID = await WorkflowSeats.ensureSession(ctx.scopeID, ctx.runID, targetSeat, instance)

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
      id: Identifier.ascending("workflow_handoff"),
      runID: ctx.runID,
      entityID: ctx.entityID,
      toSeat: { seat: targetSeat, instance },
      task: taskText,
      acceptance,
      contextRefs,
      expectedSubmission: expected,
    }

    // Handing the entity to a different seat frees the seat that held it — so a
    // pool of N executors is only occupied while they are actually executing,
    // not for the whole review/test lifecycle.
    const previous = entity.assignedSeat
    const releasesPrevious = previous && (previous.seat !== targetSeat || previous.instance !== instance)

    await WorkflowRunStore.update(ctx.scopeID, ctx.runID, (draft) => {
      const e = draft.entities.find((x) => x.id === ctx.entityID)
      if (e) {
        e.pendingHandoffID = handoff.id
        e.assignedSeat = { seat: targetSeat, instance: instance! }
        e.bindings.seatSessionID = sessionID
        e.time.updated = Date.now()
      }
      if (releasesPrevious && previous) {
        const prevBinding = WorkflowSeats.find(draft, previous.seat, previous.instance)
        if (prevBinding && prevBinding.entityID === ctx.entityID) {
          prevBinding.entityID = undefined
          prevBinding.activeTaskID = undefined
          prevBinding.status = "idle"
        }
      }
      const binding = WorkflowSeats.find(draft, targetSeat, instance!)
      if (binding) {
        binding.entityID = ctx.entityID
        binding.status = "waiting"
      }
    })
    if (releasesPrevious && previous) {
      await WorkflowRunStore.appendEvent(
        ctx.scopeID,
        { id: ctx.runID },
        { kind: "seat_released", entityID: ctx.entityID, seat: previous.seat, data: { instance: previous.instance } },
      )
    }
    const taskID = await WorkflowHandoff.deliver(ctx.scopeID, sessionID, handoff, entity)
    await WorkflowRunStore.update(ctx.scopeID, ctx.runID, (draft) => {
      const binding = WorkflowSeats.find(draft, targetSeat, instance!)
      if (binding) {
        binding.activeTaskID = taskID
        binding.entityID = ctx.entityID
        binding.status = "working"
      }
    })
    await WorkflowRunStore.appendEvent(
      ctx.scopeID,
      { id: ctx.runID },
      {
        kind: "handoff_sent",
        entityID: ctx.entityID,
        seat: targetSeat,
        data: { handoffID: handoff.id, sessionID, taskID },
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
      noteID,
      title: entity.title,
      description: entity.description,
      sessionID,
      runMode: "current",
      source: "workflow",
    })
    await WorkflowRunStore.update(ctx.scopeID, ctx.runID, (draft) => {
      const e = draft.entities.find((x) => x.id === ctx.entityID)
      if (e) {
        e.bindings.loopID = loop.id
        e.time.updated = Date.now()
      }
    })
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
    await WorkflowRunStore.update(ctx.scopeID, ctx.runID, (draft) => {
      const e = draft.entities.find((x) => x.id === ctx.entityID)
      if (e && workspace) {
        if (typeof workspace.worktreeID === "string") e.bindings.worktreeID = workspace.worktreeID
        if (typeof workspace.resolvedBaseCommit === "string") e.bindings.baseCommit = workspace.resolvedBaseCommit
        e.time.updated = Date.now()
      }
    })
  })

  register("spawn_contractor", async (ctx, args) => {
    const agent = argString(args, "agent")
    if (!agent) throw new Error("spawn_contractor requires 'agent'")
    const prompt = argString(args, "prompt") ?? "Perform the requested independent task and report a concise result."
    const run = await WorkflowRunStore.get(ctx.scopeID, ctx.runID)
    const boss = run.bossSessionID
    const { Cortex } = await import("../cortex")
    const task = await Cortex.launch({
      description: `Contractor for ${ctx.entityID}`,
      prompt,
      agent,
      parentSessionID: boss,
      parentMessageID: Identifier.ascending("message"),
      visibility: "hidden",
      owner: {
        kind: "workflow_run",
        runID: ctx.runID,
        entityID: ctx.entityID,
        correlationID: `workflow:${ctx.runID}:entity:${ctx.entityID}:contractor`,
      },
    }).catch((error) => {
      throw new Error(`contractor launch failed: ${error instanceof Error ? error.message : String(error)}`)
    })
    await WorkflowRunStore.appendEvent(
      ctx.scopeID,
      { id: ctx.runID },
      {
        kind: "contractor_spawned",
        entityID: ctx.entityID,
        data: { taskID: task.id, agent },
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
    const gateID = Identifier.ascending("workflow_gate")
    await WorkflowRunStore.update(ctx.scopeID, ctx.runID, (draft) => {
      draft.gates.push({
        id: gateID,
        gate: gateName,
        entityID: ctx.entityID,
        transitionID: ctx.transitionID,
        status: "pending",
        context,
        time: { created: Date.now() },
      })
    })
    await WorkflowRunStore.appendEvent(
      ctx.scopeID,
      { id: ctx.runID },
      {
        kind: "gate_opened",
        entityID: ctx.entityID,
        data: { gate: gateName, gateID },
      },
    )
    await deliverBossNotice(
      ctx.scopeID,
      ctx.runID,
      `Gate "${gateDef.title}" awaits your decision for "${entity.title}". Resolutions: ${gateDef.resolutions.join(", ")}.`,
    )
  })

  register("notify_boss", async (ctx, args) => {
    const message = argString(args, "message") ?? "Workflow update."
    await deliverBossNotice(ctx.scopeID, ctx.runID, message)
  })

  register("set_binding", async (ctx, args) => {
    const key = argString(args, "key")
    if (!key) throw new Error("set_binding requires 'key'")
    const run = await WorkflowRunStore.get(ctx.scopeID, ctx.runID)
    const entity = run.entities.find((e) => e.id === ctx.entityID)
    if (!entity) throw new Error("entity not found")
    const value = resolveEntityArg(argString(args, "value"), entity, run) ?? argString(args, "value")
    await WorkflowRunStore.update(ctx.scopeID, ctx.runID, (draft) => {
      const e = draft.entities.find((x) => x.id === ctx.entityID)
      if (e && value !== undefined) {
        e.bindings[key] = value
        e.time.updated = Date.now()
      }
    })
  })

  register("release_seat", async (ctx) => {
    await WorkflowRunStore.update(ctx.scopeID, ctx.runID, (draft) => {
      const entity = draft.entities.find((e) => e.id === ctx.entityID)
      const seat = entity?.assignedSeat
      if (seat) {
        const binding = WorkflowSeats.find(draft, seat.seat, seat.instance)
        if (binding) {
          binding.status = "idle"
          binding.entityID = undefined
          binding.activeTaskID = undefined
        }
      }
    })
    const run = await WorkflowRunStore.get(ctx.scopeID, ctx.runID)
    const entity = run.entities.find((e) => e.id === ctx.entityID)
    if (entity?.assignedSeat) {
      await WorkflowRunStore.appendEvent(
        ctx.scopeID,
        { id: ctx.runID },
        {
          kind: "seat_released",
          entityID: ctx.entityID,
          seat: entity.assignedSeat.seat,
        },
      )
    }
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
