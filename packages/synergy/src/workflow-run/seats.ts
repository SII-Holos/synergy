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
 * SeatBinding is the durable allocation record for a session and its current
 * entity. Live status is projected from the Session runtime, not treated as a
 * second write-path source of truth.
 */
export namespace WorkflowSeats {
  const sessionCreations = new Map<string, Promise<string>>()

  export function find(run: WorkflowTypes.Run, seat: string, instance: number): WorkflowTypes.SeatBinding | undefined {
    return run.seats.find((s) => s.seat === seat && s.instance === instance)
  }

  export function currentEntity(
    run: WorkflowTypes.Run,
    input: { seat: string; instance: number; sessionID?: string },
  ): WorkflowTypes.Entity | undefined {
    const binding = find(run, input.seat, input.instance)
    if (!binding?.entityID) return undefined
    if (input.sessionID && binding.sessionID !== input.sessionID) return undefined
    return run.entities.find((entity) => entity.id === binding.entityID)
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

    const key = `${scopeID}:${runID}:${seat}:${instance}`
    const active = sessionCreations.get(key)
    if (active) return active
    const creation = createSession(scopeID, runID, seat, instance).finally(() => sessionCreations.delete(key))
    sessionCreations.set(key, creation)
    return creation
  }

  async function createSession(scopeID: string, runID: string, seat: string, instance: number): Promise<string> {
    const run = await WorkflowRunStore.get(scopeID, runID)
    const existing = find(run, seat, instance)
    if (existing?.sessionID) return existing.sessionID

    const charter = await CharterStore.get(scopeID, run.charterRef.id, run.charterRef.version)
    const def = seatDef(charter, seat)
    if (!def) throw new Error(`Charter ${charter.id} has no seat '${seat}'`)

    const bossSession = await Session.get(run.bossSessionID)
    const orphan = await findOrphanSession(run.bossSessionID, runID, seat, instance)
    if (orphan) {
      await Session.update(orphan.id, (draft) => {
        draft.workflowRun = { runID, role: "seat", seat, instance }
        draft.agentOverride = def.agent
        if (def.model) draft.modelOverride = def.model
      })
    }
    const session =
      orphan ??
      (await Session.create({
        scope: bossSession.scope,
        parentID: run.bossSessionID,
        title: `${run.title} · ${seat}#${instance}`,
        agentOverride: def.agent,
        interaction:
          def.interaction === "unattended"
            ? SessionInteraction.unattended("workflow_run")
            : SessionInteraction.interactive("workflow_run"),
        workflowRun: { runID, role: "seat", seat, instance },
        modelOverride: def.model,
      }))

    const sessionID = session.id

    if (def.worktree === "shared") {
      await createSeatWorktree(sessionID, `${run.title}-${seat}-${instance}`.slice(0, 60))
    }

    await WorkflowRunStore.update(
      scopeID,
      runID,
      (draft) => {
        const binding = find(draft, seat, instance)
        if (binding) {
          binding.sessionID = sessionID
          binding.status = binding.entityID ? "waiting" : "idle"
        }
      },
      { expectedRunStatus: "active" },
    )
    await WorkflowRunStore.appendEvent(
      scopeID,
      { id: runID },
      {
        id: `wfv_seat_session_${runID}_${seat}_${instance}`,
        kind: "seat_session_created",
        seat,
        data: { instance, sessionID },
      },
    )
    return sessionID
  }

  async function findOrphanSession(
    bossSessionID: string,
    runID: string,
    seat: string,
    instance: number,
  ): Promise<Session.Info | undefined> {
    for await (const child of Session.listAll()) {
      if (child.parentID !== bossSessionID || child.time.archived) continue
      if (
        child.workflowRun?.runID === runID &&
        child.workflowRun.role === "seat" &&
        child.workflowRun.seat === seat &&
        child.workflowRun.instance === instance
      ) {
        return child
      }
    }
  }

  /** Bind the session to the workspace required by the entity it now owns. */
  export async function prepareWorktree(
    scopeID: string,
    runID: string,
    seat: string,
    instance: number,
    entityID: string,
  ): Promise<void> {
    const run = await WorkflowRunStore.get(scopeID, runID)
    const charter = await CharterStore.get(scopeID, run.charterRef.id, run.charterRef.version)
    const def = seatDef(charter, seat)
    if (!def || def.worktree === "none" || def.worktree === "shared") return

    const binding = find(run, seat, instance)
    if (!binding?.sessionID || binding.entityID !== entityID) {
      throw new Error(`Seat ${seat}#${instance} no longer owns entity ${entityID}`)
    }
    const entity = run.entities.find((item) => item.id === entityID)
    if (!entity) throw new Error(`Entity ${entityID} not found`)

    const sessionID = binding.sessionID
    await isolatedWorkspace(async () => {
      const session = await Session.get(sessionID)
      const currentID = session.workspace?.type === "git_worktree" ? session.workspace.worktreeID : undefined
      const wantedID = entity.bindings.worktreeID
      if (wantedID && currentID === wantedID) return

      const current = await currentOwnedWorktree(sessionID)
      const claimedByAnotherEntity = run.entities.some(
        (item) => item.id !== entityID && item.bindings.worktreeID === current?.id,
      )
      if (!wantedID && current && !claimedByAnotherEntity) {
        await bindEntityWorktree(scopeID, runID, seat, instance, entityID, current)
        return
      }

      if (session.workspace?.type === "git_worktree") await Worktree.leave(sessionID)
      if (wantedID) {
        await Worktree.enter({ sessionID, target: wantedID })
        return
      }

      const info = await Worktree.create({
        sessionID,
        name: `${run.title}-${seat}-${entityID}`.slice(0, 60),
        baseRef: "current",
        bind: true,
      })
      await bindEntityWorktree(scopeID, runID, seat, instance, entityID, info)
    })
  }

  async function bindEntityWorktree(
    scopeID: string,
    runID: string,
    seat: string,
    instance: number,
    entityID: string,
    worktree: Pick<Worktree.Info, "id" | "resolvedBaseCommit">,
  ) {
    await WorkflowRunStore.update(
      scopeID,
      runID,
      (draft) => {
        const currentBinding = find(draft, seat, instance)
        const currentEntity = draft.entities.find((item) => item.id === entityID)
        if (currentBinding?.entityID !== entityID || !currentEntity) return
        currentEntity.bindings.worktreeID = worktree.id
        if (worktree.resolvedBaseCommit) currentEntity.bindings.baseCommit = worktree.resolvedBaseCommit
        currentEntity.time.updated = Date.now()
      },
      { expectedRunStatus: "active" },
    )
  }

  /**
   * Project live seat status from allocation + runtime. Prefer this over the
   * persisted status field when presenting runs to the UI/API.
   */
  export function liveStatus(binding: WorkflowTypes.SeatBinding): WorkflowTypes.SeatBinding["status"] {
    if (!binding.sessionID) return "unbound"
    if (SessionManager.isRunning(binding.sessionID)) return "working"
    if (binding.entityID) return "waiting"
    return "idle"
  }

  export function withProjectedStatus(run: WorkflowTypes.Run): WorkflowTypes.Run {
    if (WorkflowTypes.isTerminalRun(run.status)) return run
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
   * Idle = no allocated entity.
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
    const idle = bindings.filter((b) => !b.entityID)
    if (idle.length === 0) return undefined
    if (affinityKey) {
      const affine = idle.find((b) =>
        b.lastEntityIDs.some((entityID) =>
          run.entities.some((e) => e.id === entityID && e.affinityKey === affinityKey),
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
    await isolatedWorkspace(async () => {
      const session = await Session.get(sessionID)
      if (await currentOwnedWorktree(sessionID)) return
      if (session.workspace?.type === "git_worktree") await Worktree.leave(sessionID)
      await Worktree.create({ sessionID, name, baseRef: "current", bind: true })
    })
  }

  async function currentOwnedWorktree(sessionID: string): Promise<Worktree.Info | undefined> {
    const current = (await Worktree.status(sessionID)).worktree
    if (!current?.managed || current.stale || current.lifecycle === "deleted") return undefined
    if (current.owner?.type !== "session" || current.owner.sessionID !== sessionID) return undefined
    return current
  }

  async function isolatedWorkspace<T>(fn: () => Promise<T>): Promise<T> {
    const scope = ScopeContext.current.scope
    const workspace = ScopeContext.current.workspace
    return ScopeContext.provide({ scope, workspace, fn })
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
