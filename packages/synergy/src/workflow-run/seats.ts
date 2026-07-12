import { ScopeContext } from "../scope/context"
import { Session } from "../session"
import { SessionInteraction } from "../session/interaction"
import { SessionManager } from "../session/manager"
import { Worktree } from "../project/worktree"
import { CharterStore } from "./charter-store"
import { WorkflowRunStore } from "./store"
import { WorkflowTypes } from "./types"

/**
 * Seat session lifecycle. Seat sessions are lazily created (the first time an
 * entity is assigned to a seat instance) and never silently deleted — they are
 * audit material.
 *
 * SeatBinding is an allocation record (session + entity + optional active task).
 * Live status is projected from Cortex/Session runtime, not treated as a second
 * write-path source of truth.
 */
export namespace WorkflowSeats {
  export function find(run: WorkflowTypes.Run, seat: string, instance: number): WorkflowTypes.SeatBinding | undefined {
    return run.seats.find((s) => s.seat === seat && s.instance === instance)
  }

  export function seatDef(charter: WorkflowTypes.Charter, seat: string): WorkflowTypes.SeatDef | undefined {
    return charter.seats.find((s) => s.name === seat)
  }

  /**
   * Ensure the given seat instance has a live session; create one if needed.
   * Returns the sessionID. Idempotent: a seat binding that already has a
   * sessionID is returned unchanged.
   */
  export async function ensureSession(scopeID: string, runID: string, seat: string, instance: number): Promise<string> {
    const run = await WorkflowRunStore.get(scopeID, runID)
    const existing = find(run, seat, instance)
    if (existing?.sessionID) return existing.sessionID

    const charter = await CharterStore.get(scopeID, run.charterRef.id, run.charterRef.version)
    const def = seatDef(charter, seat)
    if (!def) throw new Error(`Charter ${charter.id} has no seat '${seat}'`)

    const bossSession = await Session.get(run.bossSessionID)
    const session = await Session.create({
      scope: bossSession.scope,
      parentID: run.bossSessionID,
      title: `${run.title} · ${seat}#${instance}`,
      agentOverride: def.agent,
      interaction:
        def.interaction === "unattended"
          ? SessionInteraction.unattended("workflow_run")
          : SessionInteraction.interactive("workflow_run"),
    })

    const sessionID = session.id
    // Child sessions inherit controlProfile through the parent chain by default.
    // SeatDef.controlProfile is an explicit worker contract, so set it on the
    // seat session itself after create (Session.create clears controlProfile for
    // parented sessions).
    await Session.updateControlProfile(sessionID, def.controlProfile, (draft) => {
      draft.workflowRun = { runID, role: "seat", seat, instance }
      if (def.model) draft.modelOverride = def.model
    })

    // shared/per_entity worktree is required for executor isolation. Failure is
    // hard — continuing in the boss/main workspace would silently mis-route work.
    if (def.worktree === "per_entity" || def.worktree === "shared") {
      await createSeatWorktree(sessionID, `${run.title}-${seat}-${instance}`.slice(0, 60))
    }

    await WorkflowRunStore.update(scopeID, runID, (draft) => {
      const binding = find(draft, seat, instance)
      if (binding) {
        binding.sessionID = sessionID
        binding.status = "idle"
        binding.entityID = undefined
        binding.activeTaskID = undefined
      }
    })
    await WorkflowRunStore.appendEvent(
      scopeID,
      { id: runID },
      {
        kind: "seat_session_created",
        seat,
        data: { instance, sessionID },
      },
    )
    return sessionID
  }

  /**
   * Project live seat status from allocation + runtime. Prefer this over the
   * persisted status field when presenting runs to the UI/API.
   */
  export function liveStatus(binding: WorkflowTypes.SeatBinding): WorkflowTypes.SeatBinding["status"] {
    if (!binding.sessionID) return "unbound"
    if (binding.activeTaskID) {
      try {
        // Lazy require avoids circular imports in pure unit tests that never load Cortex.
        const { Cortex } = require("../cortex") as typeof import("../cortex")
        const task = Cortex.get(binding.activeTaskID)
        if (task && (task.status === "running" || task.status === "queued" || task.status === "pending")) {
          return "working"
        }
      } catch {
        // Cortex unavailable in unit tests — fall through.
      }
    }
    if (SessionManager.isRunning(binding.sessionID)) return "working"
    if (binding.entityID) return "waiting"
    return "idle"
  }

  export function withProjectedStatus(run: WorkflowTypes.Run): WorkflowTypes.Run {
    return {
      ...run,
      seats: run.seats.map((seat) => ({
        ...seat,
        status: liveStatus(seat),
      })),
    }
  }

  /**
   * Choose a seat instance for an entity. Prefers (1) an idle instance that
   * recently handled an entity with the same affinityKey, then (2) any idle
   * instance, then (3) undefined when the pool is fully occupied.
   *
   * Idle = no allocated entity and no active Cortex task.
   */
  export function pickInstance(
    run: WorkflowTypes.Run,
    charter: WorkflowTypes.Charter,
    seat: string,
    affinityKey?: string,
  ): number | undefined {
    const def = seatDef(charter, seat)
    if (!def) return undefined
    const bindings = Array.from(
      { length: def.pool },
      (_, instance) => find(run, seat, instance) ?? emptyBinding(seat, instance),
    )
    const idle = bindings.filter((b) => !b.entityID && !b.activeTaskID)
    if (idle.length === 0) return undefined
    if (affinityKey) {
      const affine = idle.find((b) =>
        run.entities.some(
          (e) =>
            e.affinityKey === affinityKey && e.assignedSeat?.seat === seat && e.assignedSeat.instance === b.instance,
        ),
      )
      if (affine) return affine.instance
    }
    return idle[0].instance
  }

  function emptyBinding(seat: string, instance: number): WorkflowTypes.SeatBinding {
    return { seat, instance, status: "unbound", lastEntityIDs: [] }
  }

  /**
   * Create a worktree for a seat/entity session, bound to that session, without
   * leaking the workspace switch into the caller's ambient context.
   */
  export async function createSeatWorktree(sessionID: string, name: string): Promise<void> {
    const scope = ScopeContext.current.scope
    const ambientWorkspace = ScopeContext.current.workspace
    const run = () => Worktree.create({ sessionID, name, baseRef: "current", bind: true }).then(() => undefined)
    if (!ambientWorkspace) {
      await run()
      return
    }
    await ScopeContext.provide({ scope, workspace: ambientWorkspace, fn: run })
  }

  /** Initialise seat bindings for a fresh run from the charter's seat defs. */
  export function initialBindings(charter: WorkflowTypes.Charter): WorkflowTypes.SeatBinding[] {
    const bindings: WorkflowTypes.SeatBinding[] = []
    for (const def of charter.seats) {
      for (let instance = 0; instance < def.pool; instance++) {
        bindings.push({ seat: def.name, instance, status: "unbound", lastEntityIDs: [] })
      }
    }
    return bindings
  }
}
