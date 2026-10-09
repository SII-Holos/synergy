import { z } from "zod"
import { withStorageQueueOptions } from "../../storage/queue"
import { workMap } from "../../util/queue"
import { Storage } from "../../storage/storage"
import { RolloutArtifact } from "./artifact"
import { RolloutJournal } from "./journal"
import { RolloutSchema } from "./schema"

export namespace RolloutSnapshot {
  export const Info = z
    .object({
      version: z.literal(1),
      owner: RolloutSchema.Owner,
      revision: z.number().int().nonnegative(),
      gaps: z.array(z.number().int().positive()),
      runs: z.array(RolloutSchema.RunRecord),
      segments: z.array(RolloutSchema.ExecutionSegment),
      intervals: z.array(RolloutSchema.ExecutionInterval).default([]),
      calls: z.array(RolloutSchema.CallRecord),
      attempts: z.array(RolloutSchema.AttemptRecord),
      tools: z.array(RolloutSchema.ToolExecutionRecord),
      processes: z.array(RolloutSchema.ProcessRecord),
    })
    .strict()
    .meta({ ref: "RolloutSnapshot" })
  export type Info = z.infer<typeof Info>

  export async function read(
    owner: RolloutSchema.Owner,
    options: { revision?: number; runID?: string; onProgress?: () => void } = {},
  ): Promise<Info> {
    const revision = options.revision ?? (await RolloutJournal.head(owner)).committed
    return fold(owner, revision, options)
  }

  const Checkpoint = z.object({ version: z.literal(1), boundary: z.string(), snapshot: Info }).strict()

  async function optional<T>(key: string[]) {
    return Storage.versioned<T>(key).catch((error) => {
      if (error instanceof Storage.NotFoundError) return undefined
      throw error
    })
  }

  export function currentAll(owners: RolloutSchema.Owner[]) {
    return workMap(8, owners, current)
  }

  /** Discardable presentation checkpoint; recovery and archives use strict read(). */
  export async function current(owner: RolloutSchema.Owner): Promise<Info> {
    const root = RolloutArtifact.root(owner)
    const key = [...root, "snapshot-v1"]
    const headKey = [...root, "journal", "head"]
    const head = await optional(headKey)
    const revision = (await RolloutJournal.head(owner)).committed
    if (!revision) return fold(owner, 0)
    const raw = await optional(key)
    const checkpoint = Checkpoint.safeParse(raw?.value)
    let seed: Info | undefined
    const eventKey = (seq: number) => [...root, "journal", "events", String(seq).padStart(12, "0")]
    if (
      checkpoint.success &&
      checkpoint.data.snapshot.revision <= revision &&
      JSON.stringify(checkpoint.data.snapshot.owner) === JSON.stringify(RolloutSchema.Owner.parse(owner))
    ) {
      const boundary = await optional(eventKey(checkpoint.data.snapshot.revision))
      if (boundary?.revision.toString() === checkpoint.data.boundary) seed = checkpoint.data.snapshot
    }
    if (seed?.revision === revision) return seed
    const snapshot = await withStorageQueueOptions({ priority: "background" }, () => fold(owner, revision, {}, seed))
    const boundary = await Storage.versioned(eventKey(revision))
    await Storage.transaction(async () => {
      const latest = await optional(headKey)
      if (!head || latest?.revision !== head.revision) return
      await Storage.write(key, { version: 1, boundary: boundary.revision.toString(), snapshot })
    })
    return snapshot
  }

  async function fold(
    owner: RolloutSchema.Owner,
    revision: number,
    options: { runID?: string; onProgress?: () => void } = {},
    seed?: Info,
  ): Promise<Info> {
    const snapshot: Info = {
      version: 1,
      owner: RolloutSchema.Owner.parse(owner),
      revision,
      gaps: seed?.gaps.slice() ?? [],
      runs: [],
      segments: [],
      intervals: [],
      calls: [],
      attempts: [],
      tools: [],
      processes: [],
    }
    const latest = new Map<string, { key: string[]; value: unknown }>()
    if (seed) {
      const add = (key: string[], value: unknown) =>
        latest.set(key.join("/"), {
          key,
          value,
        })
      for (const run of seed.runs) add(["runs", run.id, "info"], run)
      for (const kind of ["segments", "intervals", "calls", "tools", "processes"] as const)
        for (const item of seed[kind]) add(["runs", item.runID, kind, item.id], item)
      for (const item of seed.attempts) add(["runs", item.runID, "attempts", item.callID, item.id], item)
    }
    if (revision)
      for await (const event of RolloutJournal.events(owner, revision, seed?.revision ?? 0)) {
        options.onProgress?.()
        if (event.kind === "gap") {
          snapshot.gaps.push(event.seq)
          continue
        }
        if (event.key[0] !== "runs" || event.key.length < 3) throw new Error("Invalid rollout journal record path")
        if (options.runID !== undefined && event.key[1] !== options.runID) continue
        latest.set(event.key.join("/"), event)
      }
    function check(value: { owner: RolloutSchema.Owner; id: string; runID?: string }, key: string[]) {
      if (JSON.stringify(RolloutSchema.Owner.parse(value.owner)) !== JSON.stringify(snapshot.owner))
        throw new Error("Rollout record owner mismatch")
      const runID = value.runID ?? value.id
      if (runID !== key[1] || (value.runID !== undefined && value.id !== key.at(-1)))
        throw new Error("Rollout record identity mismatch")
    }
    for (const { key, value } of latest.values()) {
      if (key.length === 3 && key[2] === "info") {
        const run = RolloutSchema.RunRecord.parse(value)
        check(run, key)
        snapshot.runs.push(run)
      } else if (key.length === 4 && key[2] === "intervals") {
        const interval = RolloutSchema.ExecutionInterval.parse(value)
        check(interval, key)
        snapshot.intervals.push(interval)
      } else if (key.length === 4 && key[2] === "segments") {
        const segment = RolloutSchema.ExecutionSegment.parse(value)
        check(segment, key)
        snapshot.segments.push(segment)
      } else if (key.length === 4 && key[2] === "calls") {
        const call = RolloutSchema.CallRecord.parse(value)
        check(call, key)
        snapshot.calls.push(call)
      } else if (key.length === 5 && key[2] === "attempts") {
        const attempt = RolloutSchema.AttemptRecord.parse(value)
        check(attempt, key)
        if (attempt.callID !== key[3]) throw new Error("Rollout attempt call mismatch")
        snapshot.attempts.push(attempt)
      } else if (key.length === 4 && key[2] === "tools") {
        const tool = RolloutSchema.ToolExecutionRecord.parse(value)
        check(tool, key)
        snapshot.tools.push(tool)
      } else if (key.length === 4 && key[2] === "processes") {
        const process = RolloutSchema.ProcessRecord.parse(value)
        check(process, key)
        snapshot.processes.push(process)
      } else throw new Error("Unknown rollout journal record")
      options.onProgress?.()
    }
    return snapshot
  }
}
