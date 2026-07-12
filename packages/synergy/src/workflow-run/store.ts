import { Bus } from "../bus"
import { Identifier } from "../id/id"
import { StoragePath } from "../storage/path"
import { Storage } from "../storage/storage"
import { WorkflowEvent } from "./event"
import { WorkflowTypes } from "./types"

/**
 * WorkflowRunStore — runs are keyed by runID (a scope hosts many concurrent
 * runs). Events are an append-only sibling collection.
 *
 * Mutations go through a single Storage.update lock. Schema validation happens
 * inside that lock before the write commits, so concurrent editors cannot lose
 * updates via a second unlocked Storage.write.
 */
export namespace WorkflowRunStore {
  export type CreateInput = {
    scopeID: string
    charterRef: { id: string; version: number }
    title: string
    bossSessionID: string
    seats: WorkflowTypes.SeatBinding[]
    maxModelCalls: number
  }

  export type UpdateResult =
    | { ok: true; run: WorkflowTypes.Run }
    | { ok: false; reason: "conflict" | "not_found"; run?: WorkflowTypes.Run }

  export async function get(scopeID: string, runID: string): Promise<WorkflowTypes.Run> {
    return Storage.read<WorkflowTypes.Run>(StoragePath.workflowRun(Identifier.asScopeID(scopeID), runID))
  }

  export async function getOrUndefined(scopeID: string, runID: string): Promise<WorkflowTypes.Run | undefined> {
    return get(scopeID, runID).catch(() => undefined)
  }

  export async function list(scopeID: string): Promise<WorkflowTypes.Run[]> {
    const sid = Identifier.asScopeID(scopeID)
    const ids = await Storage.scan(StoragePath.workflowRunsRoot(sid))
    if (ids.length === 0) return []
    const keys = ids.map((runID) => StoragePath.workflowRun(sid, runID))
    const runs = await Storage.readMany<WorkflowTypes.Run>(keys)
    return runs
      .filter((run): run is WorkflowTypes.Run => run !== undefined)
      .sort((a, b) => b.time.created - a.time.created)
  }

  export async function create(input: CreateInput): Promise<WorkflowTypes.Run> {
    const sid = Identifier.asScopeID(input.scopeID)
    const now = Date.now()
    const run = WorkflowTypes.Run.parse({
      id: Identifier.ascending("workflow_run"),
      scopeID: input.scopeID,
      charterRef: input.charterRef,
      title: input.title,
      status: "active",
      revision: 0,
      bossSessionID: input.bossSessionID,
      seats: input.seats,
      entities: [],
      gates: [],
      budget: { maxModelCalls: input.maxModelCalls, used: 0 },
      time: { created: now, updated: now },
    })
    await Storage.write(StoragePath.workflowRun(sid, run.id), run)
    await Bus.publish(WorkflowEvent.RunCreated, { run })
    await appendEvent(input.scopeID, run, { kind: "run_created", message: `Workflow run created: ${run.title}` })
    return run
  }

  /**
   * Apply a mutation under the Storage write lock.
   * Optionally require a CAS revision and/or entity source state.
   */
  export async function update(
    scopeID: string,
    runID: string,
    editor: (run: WorkflowTypes.Run) => void,
    options?: {
      expectedRevision?: number
      expectedEntityState?: { entityID: string; state: string }
    },
  ): Promise<WorkflowTypes.Run> {
    const result = await tryUpdate(scopeID, runID, editor, options)
    if (!result.ok) {
      if (result.reason === "not_found") throw new Storage.NotFoundError({ message: `Workflow run ${runID} not found` })
      throw new Error(
        options?.expectedEntityState
          ? `workflow run CAS failed for entity ${options.expectedEntityState.entityID}`
          : `workflow run CAS conflict on revision ${options?.expectedRevision}`,
      )
    }
    return result.run
  }

  export async function tryUpdate(
    scopeID: string,
    runID: string,
    editor: (run: WorkflowTypes.Run) => void,
    options?: {
      expectedRevision?: number
      expectedEntityState?: { entityID: string; state: string }
    },
  ): Promise<UpdateResult> {
    const sid = Identifier.asScopeID(scopeID)
    let committed: WorkflowTypes.Run | undefined
    let conflictRun: WorkflowTypes.Run | undefined
    let conflict = false
    try {
      await Storage.update<WorkflowTypes.Run>(StoragePath.workflowRun(sid, runID), (run) => {
        if (options?.expectedRevision !== undefined && (run.revision ?? 0) !== options.expectedRevision) {
          conflict = true
          conflictRun = structuredClone(run)
          return
        }
        if (options?.expectedEntityState) {
          const entity = run.entities.find((item) => item.id === options.expectedEntityState!.entityID)
          if (!entity || entity.state !== options.expectedEntityState.state) {
            conflict = true
            conflictRun = structuredClone(run)
            return
          }
        }
        editor(run)
        run.revision = (run.revision ?? 0) + 1
        run.time.updated = Date.now()
        const parsed = WorkflowTypes.Run.parse(run)
        Object.assign(run, parsed)
        committed = structuredClone(parsed)
      })
    } catch (error) {
      if (error instanceof Storage.NotFoundError) return { ok: false, reason: "not_found" }
      throw error
    }
    if (conflict) return { ok: false, reason: "conflict", run: conflictRun }
    if (!committed) return { ok: false, reason: "not_found" }
    await Bus.publish(WorkflowEvent.RunUpdated, { run: committed })
    return { ok: true, run: committed }
  }

  export async function appendEvent(
    scopeID: string,
    run: Pick<WorkflowTypes.Run, "id">,
    input: {
      kind: WorkflowTypes.EventKind
      entityID?: string
      seat?: string
      transitionID?: string
      message?: string
      data?: Record<string, unknown>
    },
  ): Promise<WorkflowTypes.EventInfo> {
    const sid = Identifier.asScopeID(scopeID)
    const event = WorkflowTypes.EventInfo.parse({
      id: Identifier.ascending("workflow_event"),
      runID: run.id,
      scopeID,
      kind: input.kind,
      entityID: input.entityID,
      seat: input.seat,
      transitionID: input.transitionID,
      message: input.message,
      data: input.data,
      time: { created: Date.now() },
    })
    await Storage.write(StoragePath.workflowEvent(sid, run.id, event.id), event)
    await Bus.publish(WorkflowEvent.EventAppended, { event })
    return event
  }

  export async function listEvents(scopeID: string, runID: string): Promise<WorkflowTypes.EventInfo[]> {
    const sid = Identifier.asScopeID(scopeID)
    const ids = await Storage.scan(StoragePath.workflowEventsRoot(sid, runID))
    if (ids.length === 0) return []
    const keys = ids.map((eventID) => StoragePath.workflowEvent(sid, runID, eventID))
    const events = await Storage.readMany<WorkflowTypes.EventInfo>(keys)
    return events
      .filter((event): event is WorkflowTypes.EventInfo => event !== undefined)
      .sort((a, b) => a.time.created - b.time.created)
  }

  /**
   * Whether an idempotent effect keyed by `effectKey` has already executed for
   * this run (used to make effect replay safe across recovery). We record the
   * key in the effect_executed event's data.
   */
  export async function effectAlreadyExecuted(scopeID: string, runID: string, effectKey: string): Promise<boolean> {
    const events = await listEvents(scopeID, runID)
    return events.some((e) => e.kind === "effect_executed" && e.data?.effectKey === effectKey)
  }
}
