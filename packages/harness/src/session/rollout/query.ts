import { z } from "zod"
import { Session } from ".."
import { RolloutSnapshot } from "./snapshot"
import { RolloutAccounting } from "./accounting"
import { RolloutSchema } from "./schema"
import { RolloutRecovery } from "./recovery"
import { RolloutLedger } from "./ledger"
import { RolloutExecution } from "./execution"
import { Storage } from "../../storage/storage"
import { withStorageQueueOptions } from "../../storage/queue"
import { Experiment } from "../../config/experiment"
import { prepareOwnerMigrations } from "../../migration"
import { RolloutArtifact } from "./artifact"
import { RolloutJournal } from "./journal"
import { RolloutProcess } from "./process"
import { ProcessRegistry } from "../../process/registry"
import { SessionManager } from "../manager"
import { isDeepStrictEqual } from "node:util"
import { readReleaseEvidence } from "./drainage"

export namespace RolloutQuery {
  export const releaseEvidence = readReleaseEvidence
  export const Activity = z.strictObject({
    observedAt: z.number().int().nonnegative(),
    run: RolloutSchema.RunRecord.pick({ id: true, status: true, recording: true, cancelRequestedAt: true }).extend({
      active: z.boolean(),
    }),
    runsObserved: z.number().int().positive(),
    activeExecutions: z.number().int().nonnegative(),
    processes: z.strictObject({
      active: z.number().int().nonnegative(),
      exited: z.number().int().nonnegative(),
      unknown: z.number().int().nonnegative(),
    }),
    scope: z.literal("recorded_subtree"),
    truncated: z.boolean(),
  })
  export type Activity = z.infer<typeof Activity>

  export async function activity(
    sessionID: string,
    runID: string,
    signal?: AbortSignal,
  ): Promise<Activity | undefined> {
    if (Storage.inTransaction()) throw new Error("Rollout activity must start outside a transaction")
    signal?.throwIfAborted()
    runID = RolloutSchema.RunRecord.shape.id.parse(runID)
    return withStorageQueueOptions({ signal }, async () => {
      const session = await Session.get(sessionID)
      const owner: RolloutSchema.Owner = { kind: "session", scopeID: session.scope.id, sessionID }
      return Storage.snapshot(async () => {
        let truncated = false
        let candidates = 0
        const owners = new Map<string, RolloutSchema.RunRecord[]>()
        const checked = new Set<string>()
        function identity(owner: RolloutSchema.Owner, runID: string) {
          return JSON.stringify([owner, runID])
        }
        function validate(record: { id: string; owner: RolloutSchema.Owner }, owner: RolloutSchema.Owner, id: string) {
          if (record.id !== id || !isDeepStrictEqual(record.owner, owner))
            throw new Error("Rollout activity identity mismatch")
        }
        async function current(owner: RolloutSchema.Owner) {
          signal?.throwIfAborted()
          const key = JSON.stringify(owner)
          if (checked.has(key)) return
          const head = await RolloutJournal.head(owner)
          if (head.allocated !== head.committed) throw new Error("Rollout activity requires journal recovery")
          checked.add(key)
        }
        async function childRuns(owner: RolloutSchema.Owner) {
          const key = JSON.stringify(owner)
          const previous = owners.get(key)
          if (previous) return previous
          await current(owner)
          const remaining = 256 - candidates
          const page = await Storage.childKeys({
            prefix: [...RolloutArtifact.root(owner), "runs"],
            limit: remaining + 1,
            includeBranches: true,
          })
          const keys = page.keys.slice(0, remaining)
          candidates += keys.length
          if (page.after || page.keys.length > remaining) truncated = true
          const values = await Storage.readMany(keys.map((key) => [...key, "info"]))
          const runs: RolloutSchema.RunRecord[] = []
          for (const [index, value] of values.entries()) {
            if (value === undefined) {
              truncated = true
              continue
            }
            const run = RolloutSchema.RunRecord.parse(value)
            validate(run, owner, keys[index].at(-1)!)
            runs.push(run)
          }
          owners.set(key, runs)
          return runs
        }
        await current(owner)
        const [value] = await Storage.readMany([[...RolloutArtifact.root(owner), "runs", runID, "info"]])
        if (value === undefined) return undefined
        const root = RolloutSchema.RunRecord.parse(value)
        validate(root, owner, runID)
        owners.set(JSON.stringify(owner), [root])
        candidates = 1
        const runs = [root]
        const seen = new Set([identity(owner, runID)])
        let rootActive = false
        let activeExecutions = 0
        const processes = { active: 0, exited: 0, unknown: 0 }
        for (let index = 0; index < runs.length; index++) {
          signal?.throwIfAborted()
          const run = runs[index]
          if (run.owner.kind !== "session") throw new Error("Session activity has a non-Session owner")
          const active = SessionManager.getRuntime(run.owner.sessionID)?.owner?.rootID === run.id
          if (active) activeExecutions++
          if (index === 0) rootActive = active
          const remaining = 256 - processes.active - processes.exited - processes.unknown
          const page = await Storage.childKeys({
            prefix: [...RolloutArtifact.root(run.owner), "runs", run.id, "processes"],
            limit: remaining + 1,
          })
          if (page.after || page.keys.length > remaining) truncated = true
          const records = await Storage.readMany(page.keys.slice(0, remaining))
          for (const [index, record] of records.entries()) {
            const process = RolloutSchema.ProcessRecord.parse(record)
            validate(process, run.owner, page.keys[index].at(-1)!)
            if (process.runID !== run.id) throw new Error("Rollout process activity identity mismatch")
            const live = RolloutProcess.isActive(run.owner, run.id, process.id)
              ? ProcessRegistry.get(process.id)
              : undefined
            if (live && ProcessRegistry.isAlive(live) === true) processes.active++
            else if (
              process.ended !== undefined &&
              ((typeof process.exitCode === "number" && process.exitCode >= 0) || Boolean(process.signal))
            )
              processes.exited++
            else processes.unknown++
          }
          const children = await Session.readChildIndex(run.owner.scopeID, run.owner.sessionID)
          for (const child of children.entries) {
            signal?.throwIfAborted()
            const childOwner: RolloutSchema.Owner = { kind: "session", scopeID: run.owner.scopeID, sessionID: child.id }
            if ((owners.size >= 64 || candidates >= 256) && !owners.has(JSON.stringify(childOwner))) {
              truncated = true
              break
            }
            for (const childRun of await childRuns(childOwner)) {
              if (childRun.parent?.runID !== run.id || !isDeepStrictEqual(childRun.parent.owner, run.owner)) continue
              const key = identity(childOwner, childRun.id)
              if (seen.has(key)) continue
              if (runs.length >= 64) {
                truncated = true
                continue
              }
              seen.add(key)
              runs.push(childRun)
            }
          }
        }
        signal?.throwIfAborted()
        return Activity.parse({
          observedAt: Date.now(),
          run: {
            id: root.id,
            status: root.status,
            recording: root.recording,
            cancelRequestedAt: root.cancelRequestedAt,
            active: rootActive,
          },
          runsObserved: runs.length,
          activeExecutions,
          processes,
          scope: "recorded_subtree",
          truncated,
        })
      })
    })
  }

  export const Result = z
    .object({
      version: z.literal(1),
      run: RolloutSchema.RunRecord,
      snapshots: z.array(RolloutSnapshot.Info),
      accounting: RolloutAccounting.Summary,
      elapsedMs: z.number().nonnegative(),
      elapsedActive: z.boolean(),
      elapsedLowerBound: z.boolean(),
    })
    .strict()
    .meta({ ref: "RolloutResult" })
  export type Result = z.infer<typeof Result>

  export async function tree(owner: RolloutSchema.Owner, runID: string): Promise<Result> {
    await prepareOwnerMigrations(owner)
    const root = await RolloutSnapshot.read(owner, { runID })
    const run = root.runs.find((run) => run.id === runID)
    if (!run) throw new Error(`Run not found: ${runID}`)
    const snapshots = [root]
    const seen = new Set([`${JSON.stringify(owner)}:${runID}`])
    for (let index = 0; index < snapshots.length; index++) {
      const snapshot = snapshots[index]
      if (snapshot.owner.kind !== "session") continue
      for (const child of await Session.children(snapshot.owner.sessionID)) {
        const identity = { kind: "session" as const, scopeID: child.scope.id, sessionID: child.id }
        await prepareOwnerMigrations(identity)
        const recorded = await RolloutSnapshot.read(identity)
        for (const childRun of recorded.runs) {
          const parent = childRun.parent
          if (
            !parent?.runID ||
            parent.owner.kind !== "session" ||
            parent.owner.sessionID !== snapshot.owner.sessionID ||
            !snapshot.runs.some((run) => run.id === parent.runID)
          )
            continue
          const key = `${JSON.stringify(identity)}:${childRun.id}`
          if (seen.has(key)) continue
          seen.add(key)
          snapshots.push(await RolloutSnapshot.read(identity, { runID: childRun.id, revision: recorded.revision }))
        }
      }
    }
    const timing = RolloutExecution.summarize({
      roots: [run],
      runs: snapshots.flatMap((snapshot) => snapshot.runs),
      intervals: snapshots.flatMap((snapshot) => snapshot.intervals),
      segments: snapshots.flatMap((snapshot) => snapshot.segments),
    })
    return Result.parse({
      version: 1,
      run,
      snapshots,
      accounting: RolloutAccounting.merge(snapshots.map(RolloutAccounting.summarize)),
      elapsedMs: timing.elapsedMs ?? 0,
      elapsedActive: timing.elapsedActive,
      elapsedLowerBound: timing.elapsedLowerBound,
    })
  }
  export async function find(runID: string) {
    let owner: RolloutSchema.Owner | undefined
    for await (const candidate of RolloutRecovery.owners()) {
      const run = await RolloutLedger.getRun(candidate, runID).catch((error) => {
        if (error instanceof Storage.NotFoundError) return undefined
        throw error
      })
      if (!run) continue
      if (owner) throw new Error(`Run ID is ambiguous: ${runID}`)
      owner = candidate
    }
    if (!owner) throw new Error(`Run not found: ${runID}`)
    return tree(owner, runID)
  }
  export function compare(left: Result, right: Result) {
    const a = left.run.configuration?.effective ?? {}
    const b = right.run.configuration?.effective ?? {}
    const changed = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(
      (key) =>
        Experiment.fingerprint(Reflect.get(a, key) ?? null) !== Experiment.fingerprint(Reflect.get(b, key) ?? null),
    )
    return {
      version: 1 as const,
      changedConfiguration: changed,
      initialContext: "Review each run input and session history before interpreting differences" as const,
      runs: [left, right].map(({ run, accounting, elapsedMs, elapsedActive, elapsedLowerBound }) => ({
        run,
        accounting,
        elapsedMs,
        elapsedActive,
        elapsedLowerBound,
      })),
    }
  }
}
