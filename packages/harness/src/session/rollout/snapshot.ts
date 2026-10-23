import { z } from "zod"
import { withStorageQueueOptions } from "../../storage/queue"
import { workMap } from "../../util/queue"
import { Storage } from "../../storage/storage"
import { RolloutArtifact } from "./artifact"
import { RolloutJournal } from "./journal"
import { RolloutSchema } from "./schema"
import { prepareOwnerMigrations } from "../../migration"

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

  async function settleTail(owner: RolloutSchema.Owner, onProgress?: () => void) {
    const pending = await RolloutJournal.head(owner)
    if (pending.allocated !== pending.committed) await RolloutJournal.recover(owner, onProgress)
  }

  export async function read(
    owner: RolloutSchema.Owner,
    options: { revision?: number; runID?: string; onProgress?: () => void } = {},
  ): Promise<Info> {
    await RolloutJournal.prepare(owner)
    const revision = options.revision ?? (await RolloutJournal.head(owner)).committed
    return fold(owner, revision, options)
  }

  /** Current records share the journal commit. This view does not audit historical gaps; use read() for that. */
  export async function projected(owner: RolloutSchema.Owner, runID?: string, onProgress?: () => void): Promise<Info> {
    await settleTail(owner, onProgress)
    return Storage.snapshot(async () => {
      const head = await RolloutJournal.head(owner)
      if (head.allocated !== head.committed) throw new Error("Rollout owner requires recovery")
      const base = RolloutArtifact.root(owner)
      const records = new Map<string, { key: string[]; value: unknown }>()
      const keys = await Storage.list([...base, "runs", ...(runID === undefined ? [] : [runID])])
      for (let offset = 0; offset < keys.length; offset += 512) {
        onProgress?.()
        const page = keys.slice(offset, offset + 512)
        const values = await Storage.readMany(page)
        for (const [index, fullKey] of page.entries()) {
          if (values[index] === undefined) continue
          const key = fullKey.slice(base.length)
          records.set(key.join("/"), { key, value: values[index] })
        }
      }
      return decode(empty(owner, head.committed), records, onProgress)
    })
  }

  export async function modelCalls(
    owner: RolloutSchema.Owner,
    signal?: AbortSignal,
  ): Promise<Pick<Info, "owner" | "revision" | "runs" | "calls">> {
    signal?.throwIfAborted()
    // This is recorded request metadata, not execution admission or elapsed-time migration.
    await settleTail(owner, () => signal?.throwIfAborted())
    return Storage.snapshot(async () => {
      const head = await RolloutJournal.head(owner)
      if (head.allocated !== head.committed) throw new Error("Rollout owner requires recovery")
      const base = RolloutArtifact.root(owner)
      const result: Pick<Info, "owner" | "revision" | "runs" | "calls"> = {
        owner: RolloutSchema.Owner.parse(owner),
        revision: head.committed,
        runs: [],
        calls: [],
      }
      const keys = (await Storage.scan([...base, "runs"])).map((id) => [...base, "runs", id])
      for (let offset = 0; offset < keys.length; offset += 128) {
        signal?.throwIfAborted()
        const page = keys.slice(offset, offset + 128)
        const runs = await Storage.readMany(page.map((key) => [...key, "info"]))
        for (const [index, key] of page.entries()) {
          if (runs[index] !== undefined) {
            const run = RolloutSchema.RunRecord.parse(runs[index])
            check(result.owner, run, [...key.slice(base.length), "info"])
            result.runs.push(run)
          }
          let after: string | undefined
          do {
            signal?.throwIfAborted()
            const page = await Storage.childKeys({ prefix: [...key, "calls"], after, limit: 512 })
            const values = await Storage.readMany(page.keys)
            for (const [index, callKey] of page.keys.entries()) {
              const call = RolloutSchema.CallRecord.parse(values[index])
              check(result.owner, call, callKey.slice(base.length))
              result.calls.push(call)
            }
            after = page.after
          } while (after)
        }
      }
      return result
    })
  }

  const Checkpoint = z.object({ version: z.literal(1), boundary: z.string(), snapshot: Info }).strict()

  async function optional<T>(key: string[]) {
    return Storage.versioned<T>(key).catch((error) => {
      if (error instanceof Storage.NotFoundError) return undefined
      throw error
    })
  }

  export function currentAll(owners: RolloutSchema.Owner[], signal?: AbortSignal) {
    return withStorageQueueOptions({ priority: "background", signal }, () =>
      workMap(2, owners, (owner) => current(owner, signal)),
    )
  }

  export function presentationAll(owners: RolloutSchema.Owner[], signal?: AbortSignal) {
    return withStorageQueueOptions({ priority: "background", signal }, () =>
      workMap(2, owners, (owner) => presentation(owner, signal)),
    )
  }

  export async function presentation(owner: RolloutSchema.Owner, signal?: AbortSignal) {
    signal?.throwIfAborted()
    await RolloutJournal.prepare(owner)
    await prepareOwnerMigrations(owner)
    const root = RolloutArtifact.root(owner)
    const checkpoint = await Storage.snapshot(async () => {
      const head = await RolloutJournal.head(owner)
      const saved = Checkpoint.safeParse((await optional([...root, "snapshot-v1"]))?.value)
      if (!saved.success || saved.data.snapshot.revision !== head.committed || head.allocated !== head.committed) return
      if (JSON.stringify(saved.data.snapshot.owner) !== JSON.stringify(RolloutSchema.Owner.parse(owner))) return
      const boundary = await optional([...root, "journal", "events", String(head.committed).padStart(12, "0")])
      if (boundary?.revision.toString() !== saved.data.boundary) return
      return saved.data.snapshot
    })
    if (checkpoint) return { snapshot: checkpoint, verified: true }
    const snapshot = await projected(owner, undefined, () => signal?.throwIfAborted())
    return { snapshot, verified: snapshot.revision === 0 }
  }

  /** Discardable presentation checkpoint; recovery and archives use strict read(). */
  export async function current(owner: RolloutSchema.Owner, signal?: AbortSignal): Promise<Info> {
    signal?.throwIfAborted()
    await RolloutJournal.prepare(owner)
    await prepareOwnerMigrations(owner)
    signal?.throwIfAborted()
    const root = RolloutArtifact.root(owner)
    const key = [...root, "snapshot-v1"]
    const eventKey = (seq: number) => [...root, "journal", "events", String(seq).padStart(12, "0")]
    const identity = JSON.stringify(RolloutSchema.Owner.parse(owner))
    const { revision, boundary, seed } = await Storage.snapshot(async () => {
      const revision = (await RolloutJournal.head(owner)).committed
      const checkpoint = Checkpoint.safeParse((await optional(key))?.value)
      let seed: Info | undefined
      if (
        checkpoint.success &&
        checkpoint.data.snapshot.revision <= revision &&
        JSON.stringify(checkpoint.data.snapshot.owner) === identity &&
        (await optional(eventKey(checkpoint.data.snapshot.revision)))?.revision.toString() === checkpoint.data.boundary
      )
        seed = checkpoint.data.snapshot
      return { revision, seed, boundary: revision ? await optional(eventKey(revision)) : undefined }
    })
    if (!revision) return fold(owner, 0)
    if (seed?.revision === revision) return seed
    const snapshot = await withStorageQueueOptions({ priority: "background", signal }, () =>
      fold(owner, revision, { onProgress: () => signal?.throwIfAborted() }, seed),
    )
    signal?.throwIfAborted()
    await Storage.transaction(async () => {
      if (!boundary || (await RolloutJournal.head(owner)).committed < revision) return
      if ((await optional(eventKey(revision)))?.revision !== boundary.revision) return
      const latest = Checkpoint.safeParse((await optional(key))?.value)
      if (
        latest.success &&
        latest.data.snapshot.revision >= revision &&
        JSON.stringify(latest.data.snapshot.owner) === identity &&
        (await optional(eventKey(latest.data.snapshot.revision)))?.revision.toString() === latest.data.boundary
      )
        return
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
    const snapshot = empty(owner, revision, seed?.gaps)
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
    return decode(snapshot, latest, options.onProgress)
  }

  function empty(owner: RolloutSchema.Owner, revision: number, gaps: number[] = []): Info {
    return {
      version: 1,
      owner: RolloutSchema.Owner.parse(owner),
      revision,
      gaps: gaps.slice(),
      runs: [],
      segments: [],
      intervals: [],
      calls: [],
      attempts: [],
      tools: [],
      processes: [],
    }
  }

  function check(
    owner: RolloutSchema.Owner,
    value: { owner: RolloutSchema.Owner; id: string; runID?: string },
    key: string[],
  ) {
    if (JSON.stringify(RolloutSchema.Owner.parse(value.owner)) !== JSON.stringify(owner))
      throw new Error("Rollout record owner mismatch")
    const runID = value.runID ?? value.id
    if (runID !== key[1] || (value.runID !== undefined && value.id !== key.at(-1)))
      throw new Error("Rollout record identity mismatch")
  }

  function decode(snapshot: Info, latest: Map<string, { key: string[]; value: unknown }>, onProgress?: () => void) {
    for (const { key, value } of latest.values()) {
      if (key.length === 3 && key[2] === "info") {
        const run = RolloutSchema.RunRecord.parse(value)
        check(snapshot.owner, run, key)
        snapshot.runs.push(run)
      } else if (key.length === 4 && key[2] === "intervals") {
        const interval = RolloutSchema.ExecutionInterval.parse(value)
        check(snapshot.owner, interval, key)
        snapshot.intervals.push(interval)
      } else if (key.length === 4 && key[2] === "segments") {
        const segment = RolloutSchema.ExecutionSegment.parse(value)
        check(snapshot.owner, segment, key)
        snapshot.segments.push(segment)
      } else if (key.length === 4 && key[2] === "calls") {
        const call = RolloutSchema.CallRecord.parse(value)
        check(snapshot.owner, call, key)
        snapshot.calls.push(call)
      } else if (key.length === 5 && key[2] === "attempts") {
        const attempt = RolloutSchema.AttemptRecord.parse(value)
        check(snapshot.owner, attempt, key)
        if (attempt.callID !== key[3]) throw new Error("Rollout attempt call mismatch")
        snapshot.attempts.push(attempt)
      } else if (key.length === 4 && key[2] === "tools") {
        const tool = RolloutSchema.ToolExecutionRecord.parse(value)
        check(snapshot.owner, tool, key)
        snapshot.tools.push(tool)
      } else if (key.length === 4 && key[2] === "processes") {
        const process = RolloutSchema.ProcessRecord.parse(value)
        check(snapshot.owner, process, key)
        snapshot.processes.push(process)
      } else throw new Error("Unknown rollout journal record")
      onProgress?.()
    }
    return snapshot
  }
}
