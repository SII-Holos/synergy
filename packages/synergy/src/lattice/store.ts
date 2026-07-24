import { Bus } from "../bus"
import { createHash } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import { Identifier } from "../id/id"
import { ScopeContext } from "../scope/context"
import { StoragePath } from "../storage/path"
import { Storage } from "../storage/storage"
import { Lock } from "../util/lock"
import { LatticeError } from "./error"
import { LatticeEvent } from "./event"
import { LatticeMachine } from "./machine"
import { LatticeTypes } from "./types"

export namespace LatticeStore {
  export type CreateInput = {
    sessionID: string
    mode: LatticeTypes.Mode
    maxModelCalls?: number
    goal?: string
  }

  export type Editor = (draft: LatticeTypes.Run) => LatticeTypes.Run | void

  type UpdateResult = {
    run: LatticeTypes.Run
    changed: boolean
  }

  function sessionLock(scopeID: string, sessionID: string): string {
    return `lattice:${scopeID}:${sessionID}`
  }

  async function readOptional<T>(key: string[]): Promise<T | undefined> {
    try {
      return await Storage.read<T>(key)
    } catch (error) {
      if (error instanceof Storage.NotFoundError) return undefined
      throw error
    }
  }

  async function readPointer(scopeID: string, sessionID: string): Promise<LatticeTypes.CurrentPointer | undefined> {
    const raw = await readOptional<unknown>(StoragePath.latticeCurrent(Identifier.asScopeID(scopeID), sessionID))
    return raw === undefined ? undefined : LatticeTypes.CurrentPointer.parse(raw)
  }

  async function writePointer(
    scopeID: string,
    sessionID: string,
    runID: string,
    now = Date.now(),
  ): Promise<LatticeTypes.CurrentPointer> {
    const sid = Identifier.asScopeID(scopeID)
    const previous = await readPointer(scopeID, sessionID)
    const pointer = LatticeTypes.CurrentPointer.parse({
      schemaVersion: LatticeTypes.SCHEMA_VERSION,
      scopeID,
      sessionID,
      runID,
      time: { created: previous?.time.created ?? now, updated: now },
    })
    await Storage.write(StoragePath.latticeCurrent(sid, sessionID), pointer)
    return pointer
  }

  export async function create(input: CreateInput): Promise<LatticeTypes.Run> {
    const scopeID = ScopeContext.current.scope.id
    const sid = Identifier.asScopeID(scopeID)
    let run!: LatticeTypes.Run
    {
      using _ = await Lock.write(sessionLock(scopeID, input.sessionID))
      const existing = newest(
        (await listBySession(scopeID, input.sessionID)).filter(
          (candidate) => !LatticeTypes.isTerminalRun(candidate.status),
        ),
      )
      if (existing) {
        throw new LatticeError.StateConflict({
          state: existing.state,
          reason: `session already has an active Lattice Run ${existing.id}`,
        })
      }

      const now = Date.now()
      run = LatticeTypes.Run.parse({
        schemaVersion: LatticeTypes.SCHEMA_VERSION,
        id: Identifier.ascending("lattice_run"),
        scopeID,
        sessionID: input.sessionID,
        mode: input.mode,
        maxModelCalls: input.maxModelCalls ?? 0,
        modelCallCount: 0,
        status: "active",
        state: "clarifying",
        goalSeed: input.goal,
        revision: 0,
        stateRevision: 0,
        pathwayRevision: 0,
        pathway: [],
        time: { created: now, updated: now },
      })
      await Storage.write(StoragePath.latticeRun(sid, run.id), run)
      await writePointer(scopeID, input.sessionID, run.id, now)
    }

    const view = LatticeTypes.toRunView(run)
    await Bus.publish(LatticeEvent.Created, { run: view })
    await appendEvent(scopeID, run, {
      kind: "run_created",
      state: run.state,
      message: `Lattice Run created (${run.mode})`,
    }).catch(() => undefined)
    return run
  }

  /** @deprecated v2 never overwrites history; reset creates a new Run when the current one is terminal. */
  export const reset = create

  export async function getByRunID(scopeID: string, runID: string): Promise<LatticeTypes.Run | undefined> {
    const raw = await readOptional<unknown>(StoragePath.latticeRun(Identifier.asScopeID(scopeID), runID))
    if (raw === undefined) return undefined
    const run = LatticeTypes.Run.parse(raw)
    if (run.scopeID !== scopeID || run.id !== runID) {
      throw new LatticeError.NotFound({ runID })
    }
    return run
  }

  export async function get(scopeID: string, sessionID: string): Promise<LatticeTypes.Run> {
    const pointer = await readPointer(scopeID, sessionID)
    if (pointer) {
      const run = await getByRunID(scopeID, pointer.runID)
      if (run?.sessionID === sessionID && !LatticeTypes.isTerminalRun(run.status)) return run
    }
    const repaired = await repairCurrentPointer(scopeID, sessionID)
    if (!repaired) throw new LatticeError.NotFound({ sessionID })
    return repaired
  }

  export async function getOrUndefined(scopeID: string, sessionID: string): Promise<LatticeTypes.Run | undefined> {
    try {
      return await get(scopeID, sessionID)
    } catch (error) {
      if (error instanceof LatticeError.NotFound) return undefined
      throw error
    }
  }

  export async function list(scopeID: string): Promise<LatticeTypes.Run[]> {
    const sid = Identifier.asScopeID(scopeID)
    const ids = await Storage.scan(StoragePath.latticeRunsRoot(sid))
    if (ids.length === 0) return []
    const records = await Storage.readMany<unknown>(ids.map((runID) => StoragePath.latticeRun(sid, runID)))
    return records
      .filter((record): record is unknown => record !== undefined)
      .map((record) => LatticeTypes.Run.parse(record))
      .filter((run) => run.scopeID === scopeID)
      .sort(compareRuns)
  }

  export async function listBySession(scopeID: string, sessionID: string): Promise<LatticeTypes.Run[]> {
    return (await list(scopeID)).filter((run) => run.sessionID === sessionID)
  }

  export async function listCurrent(scopeID: string): Promise<LatticeTypes.Run[]> {
    const sid = Identifier.asScopeID(scopeID)
    const [allRuns, pointerSessionIDs] = await Promise.all([
      list(scopeID),
      Storage.scan(StoragePath.latticeCurrentRoot(sid)),
    ])
    const runIDsBySession = new Map<string, string[]>()
    for (const run of allRuns) {
      const ids = runIDsBySession.get(run.sessionID) ?? []
      ids.push(run.id)
      runIDsBySession.set(run.sessionID, ids)
    }
    const sessionIDs = new Set([...pointerSessionIDs, ...runIDsBySession.keys()])
    const runs = await Promise.all(
      [...sessionIDs].map((sessionID) =>
        repairCurrentPointerFromRunIDs(scopeID, sessionID, runIDsBySession.get(sessionID) ?? []),
      ),
    )
    return runs.filter((run): run is LatticeTypes.Run => run !== undefined).sort(compareRuns)
  }

  function compareRuns(a: LatticeTypes.Run, b: LatticeTypes.Run): number {
    return a.time.created - b.time.created || a.id.localeCompare(b.id)
  }

  function newest(runs: LatticeTypes.Run[]): LatticeTypes.Run | undefined {
    return [...runs].sort(compareRuns).at(-1)
  }

  function replaceRecord(target: LatticeTypes.Run, source: LatticeTypes.Run): void {
    for (const key of Object.keys(target) as (keyof LatticeTypes.Run)[]) delete target[key]
    Object.assign(target, source)
  }

  async function updateRecordUnlocked(scopeID: string, runID: string, editor: Editor): Promise<UpdateResult> {
    const sid = Identifier.asScopeID(scopeID)
    let changed = false
    const updated = await Storage.update<LatticeTypes.Run>(StoragePath.latticeRun(sid, runID), (stored) => {
      const current = LatticeTypes.Run.parse(stored)
      const working = structuredClone(current)
      const replacement = editor(working)
      const candidate = LatticeTypes.Run.parse(replacement ?? working)
      if (
        candidate.id !== current.id ||
        candidate.scopeID !== current.scopeID ||
        candidate.sessionID !== current.sessionID
      ) {
        throw new LatticeError.StateConflict({
          state: current.state,
          reason: "a Run update cannot change its id, scopeID, or sessionID",
        })
      }
      if (isDeepStrictEqual(candidate, current)) return
      candidate.revision = current.revision + 1
      candidate.time.updated = Date.now()
      const parsed = LatticeTypes.Run.parse(candidate)
      replaceRecord(stored, parsed)
      changed = true
    })
    return { run: LatticeTypes.Run.parse(updated), changed }
  }

  export async function updateByRunID(scopeID: string, runID: string, editor: Editor): Promise<LatticeTypes.Run> {
    const before = await getByRunID(scopeID, runID)
    if (!before) throw new LatticeError.NotFound({ runID })
    let result!: UpdateResult
    {
      using _ = await Lock.write(sessionLock(scopeID, before.sessionID))
      result = await updateRecordUnlocked(scopeID, runID, editor)
    }
    if (result.changed) await Bus.publish(LatticeEvent.Updated, { run: LatticeTypes.toRunView(result.run) })
    return result.run
  }

  export async function update(scopeID: string, sessionID: string, editor: Editor): Promise<LatticeTypes.Run> {
    let result!: UpdateResult
    {
      using _ = await Lock.write(sessionLock(scopeID, sessionID))
      const pointer = await readPointer(scopeID, sessionID)
      let current = pointer ? await getByRunID(scopeID, pointer.runID) : undefined
      if (current?.sessionID !== sessionID) current = undefined
      if (!current) {
        const candidates = await listBySession(scopeID, sessionID)
        const nonTerminal = candidates.filter((run) => !LatticeTypes.isTerminalRun(run.status))
        if (nonTerminal.length > 1) {
          const conflict = newest(nonTerminal)!
          throw new LatticeError.StateConflict({
            state: conflict.state,
            reason: "multiple non-terminal Runs require pointer reconciliation before update",
          })
        }
        current = nonTerminal[0] ?? newest(candidates)
        if (!current) throw new LatticeError.NotFound({ sessionID })
        await writePointer(scopeID, sessionID, current.id)
      }
      result = await updateRecordUnlocked(scopeID, current.id, editor)
    }
    if (result.changed) await Bus.publish(LatticeEvent.Updated, { run: LatticeTypes.toRunView(result.run) })
    return result.run
  }

  export const updateCurrent = update

  /**
   * Repair the O(1) current pointer after an interrupted create. Multiple
   * non-terminal Runs are never guessed: the newest is paused for inspection
   * and older conflicts are failed before any effect can execute.
   */
  export async function repairCurrentPointer(
    scopeID: string,
    sessionID: string,
  ): Promise<LatticeTypes.Run | undefined> {
    const candidates = await listBySession(scopeID, sessionID)
    return repairCurrentPointerFromRunIDs(
      scopeID,
      sessionID,
      candidates.map((run) => run.id),
    )
  }

  async function repairCurrentPointerFromRunIDs(
    scopeID: string,
    sessionID: string,
    runIDs: string[],
  ): Promise<LatticeTypes.Run | undefined> {
    const changed: LatticeTypes.Run[] = []
    let selected: LatticeTypes.Run | undefined
    {
      using _ = await Lock.write(sessionLock(scopeID, sessionID))
      const pointer = await readPointer(scopeID, sessionID)
      const candidateIDs = new Set(runIDs)
      if (pointer) candidateIDs.add(pointer.runID)
      const candidates = (await Promise.all([...candidateIDs].map((runID) => getByRunID(scopeID, runID)))).filter(
        (run): run is LatticeTypes.Run => run?.sessionID === sessionID,
      )
      if (candidates.length === 0) {
        if (pointer) await Storage.remove(StoragePath.latticeCurrent(Identifier.asScopeID(scopeID), sessionID))
      } else {
        const nonTerminal = candidates.filter((run) => !LatticeTypes.isTerminalRun(run.status))
        if (nonTerminal.length > 1) {
          const ordered = [...nonTerminal].sort(compareRuns)
          const newestActive = ordered.at(-1)!
          // Quarantine the selected Run first. If the process dies between
          // record writes, no later recovery can execute its stale effect.
          for (const conflict of [newestActive, ...ordered.slice(0, -1)]) {
            const result = await updateRecordUnlocked(scopeID, conflict.id, (draft) =>
              LatticeMachine.quarantineDuplicate(draft, conflict.id === newestActive.id),
            )
            if (result.changed) changed.push(result.run)
            if (result.run.id === newestActive.id) selected = result.run
          }
        } else {
          selected = nonTerminal[0] ?? newest(candidates)
        }

        if (
          selected &&
          (pointer?.scopeID !== scopeID || pointer.sessionID !== sessionID || pointer.runID !== selected.id)
        ) {
          await writePointer(scopeID, sessionID, selected.id)
        }
      }
    }
    for (const run of changed) {
      await Bus.publish(LatticeEvent.Updated, { run: LatticeTypes.toRunView(run) })
    }
    return selected
  }

  export async function appendEvent(
    scopeID: string,
    run: Pick<LatticeTypes.Run, "id" | "sessionID"> &
      Partial<Pick<LatticeTypes.Run, "stateRevision" | "pathwayRevision">>,
    input: {
      kind: LatticeTypes.EventKind
      stepID?: string
      state?: LatticeTypes.State
      message?: string
      data?: Record<string, unknown>
    },
  ): Promise<LatticeTypes.EventInfo> {
    const sid = Identifier.asScopeID(scopeID)
    const eventID = `lte_${createHash("sha256")
      .update(
        JSON.stringify({
          runID: run.id,
          kind: input.kind,
          stepID: input.stepID,
          state: input.state,
          stateRevision: run.stateRevision,
          pathwayRevision: run.pathwayRevision,
          message: input.message,
          data: input.data,
        }),
      )
      .digest("hex")
      .slice(0, 26)}`
    using _ = await Lock.write(`lattice-event:${scopeID}:${run.id}:${eventID}`)
    const existing = await readOptional<unknown>(StoragePath.latticeEvent(sid, run.id, eventID))
    if (existing !== undefined) return LatticeTypes.EventInfo.parse(existing)
    const event = LatticeTypes.EventInfo.parse({
      id: eventID,
      runID: run.id,
      scopeID,
      sessionID: run.sessionID,
      kind: input.kind,
      stepID: input.stepID,
      state: input.state,
      message: input.message,
      data: input.data,
      time: { created: Date.now() },
    })
    await Storage.write(StoragePath.latticeEvent(sid, run.id, event.id), event)
    await Bus.publish(LatticeEvent.EventAppended, { event })
    return event
  }

  export async function listEvents(scopeID: string, runID: string): Promise<LatticeTypes.EventInfo[]> {
    const sid = Identifier.asScopeID(scopeID)
    const ids = await Storage.scan(StoragePath.latticeEventsRoot(sid, runID))
    if (ids.length === 0) return []
    const records = await Storage.readMany<unknown>(ids.map((eventID) => StoragePath.latticeEvent(sid, runID, eventID)))
    return records
      .filter((record): record is unknown => record !== undefined)
      .map((record) => LatticeTypes.EventInfo.parse(record))
      .filter((event) => event.runID === runID && event.scopeID === scopeID)
      .sort((a, b) => a.time.created - b.time.created || a.id.localeCompare(b.id))
  }
}
