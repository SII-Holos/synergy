import { z } from "zod"
import { isDeepStrictEqual } from "node:util"
import { Session } from ".."
import { SessionManager } from "../manager"
import { LoopJob } from "../loop-job"
import { Storage } from "../../storage/storage"
import { withStorageQueueOptions } from "../../storage/queue"
import { ProcessRegistry } from "../../process/registry"
import { RolloutArtifact } from "./artifact"
import { RolloutJournal } from "./journal"
import { RolloutLedger } from "./ledger"
import { RolloutLifecycle } from "./lifecycle"
import { RolloutProcess } from "./process"
import { RolloutSchema } from "./schema"

async function* records<T extends { id: string }>(
  schema: z.ZodType<T>,
  prefix: string[],
  info: boolean,
  signal?: AbortSignal,
) {
  let after: string | undefined
  do {
    signal?.throwIfAborted()
    const page = await Storage.childKeys({ prefix, after, limit: 64, includeBranches: info })
    const values = await Storage.readMany(page.keys.map((key) => (info ? [...key, "info"] : key)))
    for (const [index, value] of values.entries()) {
      const record = schema.parse(value)
      if (record.id !== page.keys[index].at(-1)) throw new Error("Rollout release evidence identity mismatch")
      yield record
    }
    after = page.after
  } while (after)
}

// The caller fences new native admissions while consuming this read-only evidence.
export async function readReleaseEvidence(
  sessionID: string,
  rootID: string,
  signal?: AbortSignal,
): Promise<RolloutSchema.RunRecord | undefined> {
  if (Storage.inTransaction()) throw new Error("Rollout release evidence must start outside a transaction")
  rootID = RolloutSchema.RunRecord.shape.id.parse(rootID)
  signal?.throwIfAborted()
  return withStorageQueueOptions({ signal }, async () => {
    const session = await Session.get(sessionID)
    const owner = RolloutLifecycle.owner(session)
    const sessions = new Map<string, Session.Info>([[session.id, session]])
    const children = new Map<string, Session.Info[]>()
    const lineage = new Map<string, RolloutSchema.RunRecord["parent"]>()
    const pendingSessions = [session]
    for (let index = 0; index < pendingSessions.length; index++) {
      signal?.throwIfAborted()
      const parent = pendingSessions[index]
      const entries = (await Session.readChildIndex(parent.scope.id, parent.id)).entries
      const values: Session.Info[] = []
      for (const entry of entries) {
        const child = await Session.get(entry.id).catch((error) => {
          if (error instanceof Storage.NotFoundError) return
          throw error
        })
        if (!child) continue
        sessions.set(child.id, child)
        values.push(child)
        pendingSessions.push(child)
        lineage.set(child.id, await RolloutLifecycle.parent(child))
      }
      children.set(parent.id, values)
    }
    return Storage.snapshot(async () => {
      const root = await RolloutLedger.getRun(owner, rootID).catch((error) => {
        if (error instanceof Storage.NotFoundError) return
        throw error
      })
      if (!root) return
      if (root.id !== rootID || !isDeepStrictEqual(root.owner, owner))
        throw new Error("Rollout release root identity mismatch")
      const pending = [root]
      const seen = new Set<string>()
      const checked = new Set<string>()
      for (let index = 0; index < pending.length; index++) {
        signal?.throwIfAborted()
        const run = pending[index]
        const identity = JSON.stringify([run.owner, run.id])
        if (seen.has(identity)) continue
        seen.add(identity)
        if (
          run.owner.kind !== "session" ||
          !["completed", "failed", "cancelled"].includes(run.status) ||
          run.recording === "failed"
        )
          return
        const key = JSON.stringify(run.owner)
        if (!checked.has(key)) {
          const head = await RolloutJournal.head(run.owner)
          if (head.allocated !== head.committed) throw new Error("Rollout release evidence requires journal recovery")
          checked.add(key)
        }
        const current = SessionManager.getRuntime(run.owner.sessionID)?.owner
        if (current && (!current.rootID || current.rootID === run.id)) return
        if (LoopJob.activeBackgroundCount(run.owner.sessionID, run.id)) return
        const base = [...RolloutArtifact.root(run.owner), "runs", run.id]
        const executions = [
          records(RolloutSchema.ExecutionSegment, [...base, "segments"], false, signal),
          records(RolloutSchema.CallRecord, [...base, "calls"], false, signal),
          records(RolloutSchema.ToolExecutionRecord, [...base, "tools"], false, signal),
        ]
        for (const execution of executions)
          for await (const record of execution) {
            if (record.runID !== run.id || !isDeepStrictEqual(record.owner, run.owner))
              throw new Error("Rollout release execution identity mismatch")
            if (record.status === "running") return
          }
        for await (const process of records(RolloutSchema.ProcessRecord, [...base, "processes"], false, signal)) {
          if (process.runID !== run.id || !isDeepStrictEqual(process.owner, run.owner))
            throw new Error("Rollout release process identity mismatch")
          const live = ProcessRegistry.get(process.id)
          if (
            RolloutProcess.isActive(run.owner, run.id, process.id) ||
            (live && ProcessRegistry.isAlive(live) !== false)
          )
            return
          if (
            process.status === "running" ||
            process.ended === undefined ||
            !((typeof process.exitCode === "number" && process.exitCode >= 0) || process.signal)
          )
            return
        }
        for (const child of children.get(run.owner.sessionID) ?? []) {
          const childOwner: RolloutSchema.Owner = { kind: "session", scopeID: run.owner.scopeID, sessionID: child.id }
          const stored = sessions.get(child.id)
          if (stored?.cortex) {
            const parent = lineage.get(child.id)
            if (
              parent &&
              isDeepStrictEqual(parent.owner, run.owner) &&
              (parent.runID === null || parent.runID === run.id)
            ) {
              if (
                parent.runID === null ||
                stored.cortex.status === "queued" ||
                stored.cortex.status === "running" ||
                !stored.cortex.settledAt
              )
                return
            }
          }
          for await (const nested of records(
            RolloutSchema.RunRecord,
            [...RolloutArtifact.root(childOwner), "runs"],
            true,
            signal,
          )) {
            if (!isDeepStrictEqual(nested.owner, childOwner)) throw new Error("Rollout release child identity mismatch")
            if (!nested.parent || !isDeepStrictEqual(nested.parent.owner, run.owner)) continue
            if (nested.parent.runID === null) return
            if (nested.parent.runID === run.id) pending.push(nested)
          }
        }
      }
      signal?.throwIfAborted()
      return root
    })
  })
}
