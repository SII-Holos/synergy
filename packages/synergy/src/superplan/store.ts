import { Bus } from "../bus"
import { Identifier } from "../id/id"
import { ScopeContext } from "../scope/context"
import { StoragePath } from "../storage/path"
import { Storage } from "../storage/storage"
import { SuperPlanEvent } from "./event"
import { SuperPlanTypes } from "./types"

type NodeCreateInput = {
  id?: string
  title: string
  description?: string
  deps?: string[]
  blueprintNoteID?: string
  baseCommit?: string
}

type MergeCreateInput = {
  id?: string
  wave: number
  inputNodeIDs: string[]
  inputCommits?: string[]
  baseCommit?: string
}

export namespace SuperPlanStore {
  export async function create(input: {
    title: string
    description?: string
    plannerSessionID?: string
    summarySessionID?: string
    baseCommit?: string
    nodes?: NodeCreateInput[]
    merges?: MergeCreateInput[]
  }): Promise<SuperPlanTypes.Run> {
    const scopeID = ScopeContext.current.scope.id
    const sid = Identifier.asScopeID(scopeID)
    const now = Date.now()
    const runID = Identifier.ascending("superplan_run")

    const nodes = (input.nodes ?? []).map(
      (node): SuperPlanTypes.Node =>
        SuperPlanTypes.Node.parse({
          id: node.id ?? Identifier.ascending("superplan_node"),
          runID,
          title: node.title,
          description: node.description,
          deps: node.deps ?? [],
          blueprintNoteID: node.blueprintNoteID,
          baseCommit: node.baseCommit ?? input.baseCommit,
          status: "pending",
          time: { created: now, updated: now },
        }),
    )

    const merges = (input.merges ?? []).map(
      (merge): SuperPlanTypes.Merge =>
        SuperPlanTypes.Merge.parse({
          id: merge.id ?? Identifier.ascending("superplan_merge"),
          runID,
          wave: merge.wave,
          inputNodeIDs: merge.inputNodeIDs,
          inputCommits: merge.inputCommits ?? [],
          baseCommit: merge.baseCommit ?? input.baseCommit,
          status: "pending",
          time: { created: now, updated: now },
        }),
    )

    const run = SuperPlanTypes.Run.parse({
      id: runID,
      scopeID,
      title: input.title,
      description: input.description,
      status: "planning",
      plannerSessionID: input.plannerSessionID,
      summarySessionID: input.summarySessionID,
      baseCommit: input.baseCommit,
      nodes,
      merges,
      time: { created: now, updated: now },
    })

    await Storage.write(StoragePath.superPlanRun(sid, runID), run)
    await Bus.publish(SuperPlanEvent.Created, { run })
    await appendEvent(scopeID, runID, {
      kind: "run_created",
      message: `SuperPlan run created: ${run.title}`,
    })
    return run
  }

  export async function get(scopeID: string, runID: string): Promise<SuperPlanTypes.Run> {
    return Storage.read<SuperPlanTypes.Run>(StoragePath.superPlanRun(Identifier.asScopeID(scopeID), runID))
  }

  export async function list(scopeID: string): Promise<SuperPlanTypes.Run[]> {
    const sid = Identifier.asScopeID(scopeID)
    const ids = await Storage.scan(StoragePath.superPlanRunsRoot(sid))
    if (ids.length === 0) return []
    const keys = ids.map((runID) => StoragePath.superPlanRun(sid, runID))
    const runs = await Storage.readMany<SuperPlanTypes.Run>(keys)
    return runs.filter((run): run is SuperPlanTypes.Run => run !== undefined)
  }

  export async function update(
    scopeID: string,
    runID: string,
    editor: (run: SuperPlanTypes.Run) => void,
  ): Promise<SuperPlanTypes.Run> {
    const sid = Identifier.asScopeID(scopeID)
    const run = await Storage.update<SuperPlanTypes.Run>(StoragePath.superPlanRun(sid, runID), (draft) => {
      editor(draft)
      draft.time.updated = Date.now()
    })
    const parsed = SuperPlanTypes.Run.parse(run)
    await Storage.write(StoragePath.superPlanRun(sid, runID), parsed)
    await Bus.publish(SuperPlanEvent.Updated, { run: parsed })
    return parsed
  }

  export async function appendEvent(
    scopeID: string,
    runID: string,
    input: {
      kind: SuperPlanTypes.EventKind
      nodeID?: string
      mergeID?: string
      message?: string
      data?: Record<string, unknown>
    },
  ): Promise<SuperPlanTypes.EventInfo> {
    const sid = Identifier.asScopeID(scopeID)
    const event = SuperPlanTypes.EventInfo.parse({
      id: Identifier.ascending("superplan_event"),
      runID,
      scopeID,
      kind: input.kind,
      nodeID: input.nodeID,
      mergeID: input.mergeID,
      message: input.message,
      data: input.data,
      time: { created: Date.now() },
    })
    await Storage.write(StoragePath.superPlanEvent(sid, runID, event.id), event)
    await Bus.publish(SuperPlanEvent.EventAppended, { event })
    return event
  }

  export async function listEvents(scopeID: string, runID: string): Promise<SuperPlanTypes.EventInfo[]> {
    const sid = Identifier.asScopeID(scopeID)
    const ids = await Storage.scan(StoragePath.superPlanEventsRoot(sid, runID))
    if (ids.length === 0) return []
    const keys = ids.map((eventID) => StoragePath.superPlanEvent(sid, runID, eventID))
    const events = await Storage.readMany<SuperPlanTypes.EventInfo>(keys)
    return events.filter((event): event is SuperPlanTypes.EventInfo => event !== undefined)
  }
}
