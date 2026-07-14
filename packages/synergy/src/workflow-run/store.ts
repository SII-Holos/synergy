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
    id?: string
    scopeID: string
    charterRef: { id: string; version: number }
    title: string
    bossSessionID: string
    bossControlProfile?: WorkflowTypes.Run["bossControlProfile"]
    bossPreviousControlProfile?: WorkflowTypes.Run["bossPreviousControlProfile"]
    seats: WorkflowTypes.SeatBinding[]
    maxModelCalls: number
  }

  export type UpdateResult =
    | { ok: true; run: WorkflowTypes.Run }
    | { ok: false; reason: "conflict" | "not_found"; run?: WorkflowTypes.Run }

  export type UpdateOptions = {
    expectedRevision?: number
    expectedRunStatus?: WorkflowTypes.RunStatus | WorkflowTypes.RunStatus[]
    expectedEntityState?: { entityID: string; state: string }
  }

  export async function get(scopeID: string, runID: string): Promise<WorkflowTypes.Run> {
    return WorkflowTypes.Run.parse(
      await Storage.read<WorkflowTypes.Run>(StoragePath.workflowRun(Identifier.asScopeID(scopeID), runID)),
    )
  }

  export async function getOrUndefined(scopeID: string, runID: string): Promise<WorkflowTypes.Run | undefined> {
    try {
      return await get(scopeID, runID)
    } catch (error) {
      if (error instanceof Storage.NotFoundError) return undefined
      throw error
    }
  }

  export async function list(scopeID: string): Promise<WorkflowTypes.Run[]> {
    const sid = Identifier.asScopeID(scopeID)
    const ids = await Storage.scan(StoragePath.workflowRunsRoot(sid))
    if (ids.length === 0) return []
    const keys = ids.map((runID) => StoragePath.workflowRun(sid, runID))
    const runs = await Storage.readMany<WorkflowTypes.Run>(keys)
    return runs
      .filter((run): run is WorkflowTypes.Run => run !== undefined)
      .map((run) => WorkflowTypes.Run.parse(run))
      .sort((a, b) => b.time.created - a.time.created)
  }

  export async function create(input: CreateInput): Promise<WorkflowTypes.Run> {
    const sid = Identifier.asScopeID(input.scopeID)
    const now = Date.now()
    const run = WorkflowTypes.Run.parse({
      id: input.id ?? Identifier.ascending("workflow_run"),
      scopeID: input.scopeID,
      charterRef: input.charterRef,
      title: input.title,
      status: "active",
      revision: 0,
      bossSessionID: input.bossSessionID,
      bossControlProfile: input.bossControlProfile,
      bossPreviousControlProfile: input.bossPreviousControlProfile,
      seats: input.seats,
      entities: [],
      gates: [],
      pendingEffects: [],
      effectReceipts: {},
      budget: { maxModelCalls: input.maxModelCalls, used: 0 },
      time: { created: now, updated: now },
    })
    if (!(await Storage.writeIfAbsent(StoragePath.workflowRun(sid, run.id), run))) {
      throw new Error(`Workflow run ${run.id} already exists.`)
    }
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
    options?: UpdateOptions,
  ): Promise<WorkflowTypes.Run> {
    const result = await tryUpdate(scopeID, runID, editor, options)
    if (!result.ok) {
      if (result.reason === "not_found") throw new Storage.NotFoundError({ message: `Workflow run ${runID} not found` })
      throw new Error(
        options?.expectedRunStatus
          ? `workflow run is not in expected status ${String(options.expectedRunStatus)}`
          : options?.expectedEntityState
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
    options?: UpdateOptions,
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
        if (options?.expectedRunStatus) {
          const expected = Array.isArray(options.expectedRunStatus)
            ? options.expectedRunStatus
            : [options.expectedRunStatus]
          if (!expected.includes(run.status)) {
            conflict = true
            conflictRun = structuredClone(run)
            return
          }
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
      id?: string
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
      id: input.id ?? Identifier.ascending("workflow_event"),
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
    const key = StoragePath.workflowEvent(sid, run.id, event.id)
    if (!(await Storage.writeIfAbsent(key, event))) {
      const existing = WorkflowTypes.EventInfo.parse(await Storage.read<WorkflowTypes.EventInfo>(key))
      const sameEvent =
        existing.runID === event.runID &&
        existing.kind === event.kind &&
        existing.entityID === event.entityID &&
        existing.seat === event.seat &&
        existing.transitionID === event.transitionID &&
        existing.message === event.message &&
        JSON.stringify(existing.data) === JSON.stringify(event.data)
      if (!sameEvent) throw new Error(`Workflow event id ${event.id} is already used by a different event.`)
      return existing
    }
    await Bus.publish(WorkflowEvent.EventAppended, { event })
    return event
  }

  export async function listEvents(scopeID: string, runID: string): Promise<WorkflowTypes.EventInfo[]> {
    return (await listEventsPage(scopeID, runID, { limit: Number.MAX_SAFE_INTEGER })).items
  }

  export async function listEventsPage(
    scopeID: string,
    runID: string,
    input: { after?: string; limit?: number } = {},
  ): Promise<{ items: WorkflowTypes.EventInfo[]; nextCursor?: string }> {
    const sid = Identifier.asScopeID(scopeID)
    const ids = await Storage.scan(StoragePath.workflowEventsRoot(sid, runID))
    if (ids.length === 0) return { items: [] }
    const start = input.after ? ids.findIndex((eventID) => eventID > input.after!) : 0
    if (start < 0) return { items: [] }
    const limit = Math.max(1, input.limit ?? 100)
    const pageIDs = ids.slice(start, start + limit)
    const keys = pageIDs.map((eventID) => StoragePath.workflowEvent(sid, runID, eventID))
    const events = await Storage.readMany<WorkflowTypes.EventInfo>(keys)
    const items = events
      .filter((event): event is WorkflowTypes.EventInfo => event !== undefined)
      .sort((a, b) => a.time.created - b.time.created)
    const nextCursor = start + pageIDs.length < ids.length ? pageIDs.at(-1) : undefined
    return { items, nextCursor }
  }

  /**
   * Whether an idempotent effect keyed by `effectKey` has already executed for
   * this run (used to make effect replay safe across recovery). We record the
   * key in the effect_executed event's data.
   */
  export async function effectAlreadyExecuted(scopeID: string, runID: string, effectKey: string): Promise<boolean> {
    const run = await getOrUndefined(scopeID, runID)
    if (run?.effectReceipts?.[effectKey]) return true
    const events = await listEvents(scopeID, runID)
    return events.some((e) => e.kind === "effect_executed" && e.data?.effectKey === effectKey)
  }
}
