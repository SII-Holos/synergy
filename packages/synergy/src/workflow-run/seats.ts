import { Identifier } from "../id/id"
import { Log } from "../util/log"
import { Session } from "../session"
import { SessionInteraction } from "../session/interaction"
import { Worktree } from "../project/worktree"
import { CharterStore } from "./charter-store"
import { WorkflowRunStore } from "./store"
import { WorkflowTypes } from "./types"

/**
 * Seat session lifecycle. Seat sessions are lazily created (the first time an
 * entity is assigned to a seat instance) and never silently deleted — they are
 * audit material. Created directly via Session.create (the engine is
 * server-side; the human authorization points are run creation and gates, not
 * per-session tool permission), mirroring how Lattice / BlueprintLoop drive
 * SessionManager directly.
 */
export namespace WorkflowSeats {
  const log = Log.create({ service: "workflow.seats" })

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
      controlProfile: def.controlProfile,
      agentOverride: def.agent,
      interaction:
        def.interaction === "unattended"
          ? SessionInteraction.unattended("workflow_run")
          : SessionInteraction.interactive("workflow_run"),
    })

    let sessionID = session.id
    await Session.update(sessionID, (draft) => {
      draft.workflowRun = { runID, role: "seat", seat, instance }
    })

    // Per-seat worktree when the policy asks for one.
    if (def.worktree === "per_entity" || def.worktree === "shared") {
      try {
        await Worktree.create({
          sessionID,
          name: `${run.title}-${seat}-${instance}`.slice(0, 60),
          baseRef: "current",
          bind: true,
        })
      } catch (error) {
        log.warn("seat worktree create failed", { runID, seat, instance, error })
      }
    }

    await WorkflowRunStore.update(scopeID, runID, (draft) => {
      const binding = find(draft, seat, instance)
      if (binding) {
        binding.sessionID = sessionID
        binding.status = "idle"
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
   * Choose a seat instance for an entity. Prefers (1) an idle instance that
   * recently handled an entity with the same affinityKey, then (2) any idle
   * instance, then (3) undefined when the pool is fully occupied (the entity
   * waits in its current state — the Issue Queue).
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
    const idle = bindings.filter((b) => b.status === "idle" || b.status === "unbound")
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
