import { Bus } from "../bus"
import { Identifier } from "../id/id"
import { ScopeContext } from "../scope/context"
import { StoragePath } from "../storage/path"
import { Storage } from "../storage/storage"
import { LatticeEvent } from "./event"
import { LatticeTypes } from "./types"

/**
 * LatticeStore — one Run per session, keyed by sessionID. Re-creating a run for
 * the same session replaces the single record (never appends a parallel run).
 * Events are stored in a sibling collection so run updates stay cheap.
 */
export namespace LatticeStore {
  export type CreateInput = {
    sessionID: string
    mode: LatticeTypes.Mode
    maxModelCalls?: number
    goal?: string
  }

  export async function get(scopeID: string, sessionID: string): Promise<LatticeTypes.Run> {
    return Storage.read<LatticeTypes.Run>(StoragePath.latticeRun(Identifier.asScopeID(scopeID), sessionID))
  }

  export async function getOrUndefined(scopeID: string, sessionID: string): Promise<LatticeTypes.Run | undefined> {
    return get(scopeID, sessionID).catch(() => undefined)
  }

  export async function list(scopeID: string): Promise<LatticeTypes.Run[]> {
    const sid = Identifier.asScopeID(scopeID)
    const ids = await Storage.scan(StoragePath.latticeRunsRoot(sid))
    if (ids.length === 0) return []
    const keys = ids.map((sessionID) => StoragePath.latticeRun(sid, sessionID))
    const runs = await Storage.readMany<LatticeTypes.Run>(keys)
    return runs.filter((run): run is LatticeTypes.Run => run !== undefined)
  }

  export async function getByRunID(scopeID: string, runID: string): Promise<LatticeTypes.Run | undefined> {
    const runs = await list(scopeID)
    return runs.find((run) => run.id === runID)
  }

  /**
   * Create or replace the session's single Lattice run, starting in
   * initial_planning. Used both for first-time enable and for restart.
   */
  export async function reset(input: CreateInput): Promise<LatticeTypes.Run> {
    const scopeID = ScopeContext.current.scope.id
    const sid = Identifier.asScopeID(scopeID)
    const now = Date.now()
    const run = LatticeTypes.Run.parse({
      id: Identifier.ascending("lattice_run"),
      scopeID,
      sessionID: input.sessionID,
      mode: input.mode,
      maxModelCalls: input.maxModelCalls ?? 0,
      modelCallCount: 0,
      status: "active",
      phase: "initial_planning",
      goal: input.goal,
      firstBlueprintStarted: false,
      assumptions: [],
      pathway: [],
      time: { created: now, updated: now },
    })
    await Storage.write(StoragePath.latticeRun(sid, input.sessionID), run)
    await Bus.publish(LatticeEvent.Created, { run })
    await appendEvent(scopeID, run, { kind: "run_created", message: `Lattice run created (${run.mode})` })
    return run
  }

  export async function update(
    scopeID: string,
    sessionID: string,
    editor: (run: LatticeTypes.Run) => void,
  ): Promise<LatticeTypes.Run> {
    const sid = Identifier.asScopeID(scopeID)
    const draft = await Storage.update<LatticeTypes.Run>(StoragePath.latticeRun(sid, sessionID), (run) => {
      editor(run)
      run.time.updated = Date.now()
    })
    const parsed = LatticeTypes.Run.parse(draft)
    await Storage.write(StoragePath.latticeRun(sid, sessionID), parsed)
    await Bus.publish(LatticeEvent.Updated, { run: parsed })
    return parsed
  }

  export async function appendEvent(
    scopeID: string,
    run: Pick<LatticeTypes.Run, "id" | "sessionID">,
    input: {
      kind: LatticeTypes.EventKind
      stepID?: string
      phase?: LatticeTypes.Phase
      message?: string
      data?: Record<string, unknown>
    },
  ): Promise<LatticeTypes.EventInfo> {
    const sid = Identifier.asScopeID(scopeID)
    const event = LatticeTypes.EventInfo.parse({
      id: Identifier.ascending("lattice_event"),
      runID: run.id,
      scopeID,
      sessionID: run.sessionID,
      kind: input.kind,
      stepID: input.stepID,
      phase: input.phase,
      message: input.message,
      data: input.data,
      time: { created: Date.now() },
    })
    await Storage.write(StoragePath.latticeEvent(sid, run.sessionID, event.id), event)
    await Bus.publish(LatticeEvent.EventAppended, { event })
    return event
  }

  export async function listEvents(scopeID: string, sessionID: string): Promise<LatticeTypes.EventInfo[]> {
    const sid = Identifier.asScopeID(scopeID)
    const ids = await Storage.scan(StoragePath.latticeEventsRoot(sid, sessionID))
    if (ids.length === 0) return []
    const keys = ids.map((eventID) => StoragePath.latticeEvent(sid, sessionID, eventID))
    const events = await Storage.readMany<LatticeTypes.EventInfo>(keys)
    return events
      .filter((event): event is LatticeTypes.EventInfo => event !== undefined)
      .sort((a, b) => a.time.created - b.time.created)
  }
}
