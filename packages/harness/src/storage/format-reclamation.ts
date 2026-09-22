import fs from "node:fs/promises"
import path from "node:path"
import { z } from "zod"
import type { TransactionalStore } from "./transactional-store"
import { StorageFormatV3State } from "./format-v3-state"
import { Log } from "../util/log"

const log = Log.create({ service: "storage.reclamation" })
const passes = new WeakMap<TransactionalStore, Promise<StorageFormatV3State.State | undefined>>()
const jobs = new WeakMap<TransactionalStore, { stop(): Promise<void> }>()

export namespace StorageReclamation {
  export const Status = z
    .object({
      format: z.object({
        current: z.number().int(),
        target: z.number().int(),
        maintenanceRequired: z.boolean(),
        phase: StorageFormatV3State.Schema.shape.phase.optional(),
        restartRequired: z.boolean(),
      }),
      reclaim: z.object({
        pending: z.boolean(),
        running: z.boolean(),
        paused: z.boolean(),
        remainingPages: z.number().int().nonnegative().optional(),
        releasedPages: z.number().int().nonnegative(),
        error: z.string().optional(),
      }),
    })
    .meta({ ref: "StorageMaintenanceStatus" })
  export type Status = z.infer<typeof Status>

  export async function status(store: TransactionalStore): Promise<Status> {
    const state = await StorageFormatV3State.read(store)
    const current = store.keyEncodedAs === "bytes" ? 3 : 2
    return {
      format: {
        current,
        target: store.options.backend === "sqlite" ? 3 : 2,
        maintenanceRequired: store.options.backend === "sqlite" && current < 3,
        phase: state?.phase,
        restartRequired: Boolean(state && current < 3 && (!state.fenced || state.invalidated)),
      },
      reclaim: {
        pending: state?.phase === "reclaim",
        running: passes.has(store),
        paused: state?.paused ?? false,
        remainingPages: state?.remainingPages,
        releasedPages: state?.releasedPages ?? 0,
        error: state?.reclaimError,
      },
    }
  }

  export async function control(store: TransactionalStore, action: "pause" | "resume") {
    if (await StorageFormatV3State.read(store))
      await StorageFormatV3State.update(store, (state) => ({ ...state, paused: action === "pause" }))
    return status(store)
  }

  export function pass(store: TransactionalStore) {
    const existing = passes.get(store)
    if (existing) return existing
    const work = runPass(store).finally(() => {
      if (passes.get(store) === work) passes.delete(store)
    })
    passes.set(store, work)
    return work
  }

  async function runPass(store: TransactionalStore) {
    const state = await StorageFormatV3State.read(store)
    if (!state || state.phase !== "reclaim" || state.paused) return state
    try {
      const chunk = await store.maintain({ operation: "reclaim", maxPages: 8192 })
      return await StorageFormatV3State.update(store, (current) => ({
        ...current,
        phase: chunk.freelistPages === 0 ? "complete" : "reclaim",
        remainingPages: chunk.freelistPages,
        releasedPages: (current.releasedPages ?? 0) + chunk.releasedPages,
        reclaimError:
          chunk.freelistPages > 0 && chunk.releasedPages === 0
            ? chunk.autoVacuum === "incremental"
              ? "Space reclamation made no progress; it will retry when the database is idle"
              : "Incremental auto-vacuum requires an explicit maintenance window"
            : undefined,
      }))
    } catch (error) {
      await StorageFormatV3State.update(store, (current) => ({
        ...current,
        reclaimError: error instanceof Error ? error.name : "Reclamation failed",
      })).catch(() => undefined)
      throw error
    }
  }

  export async function drain(
    store: TransactionalStore,
    options: { signal?: AbortSignal; progress?: (current: number, total: number, phase: number) => void } = {},
  ) {
    let stalled = 0
    let previous = (await StorageFormatV3State.read(store))?.releasedPages ?? 0
    options.progress?.(0, 0, 5)
    for (;;) {
      options.signal?.throwIfAborted()
      const state = await pass(store)
      options.progress?.(state?.releasedPages ?? 0, 0, 5)
      if (!state || state.phase !== "reclaim" || state.paused) return status(store)
      stalled = (state.releasedPages ?? 0) > previous ? 0 : stalled + 1
      previous = state.releasedPages ?? 0
      if (stalled >= 4) return status(store)
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
    }
  }

  export function start(
    store: TransactionalStore,
    options: { busy(): boolean; intervalMs?: number; now?: () => number },
  ) {
    const existing = jobs.get(store)
    if (existing) return existing.stop
    const now = options.now ?? Date.now
    let stopped = false
    let running: Promise<void> | undefined
    let retryAt = 0
    let failures = 0
    const tick = async () => {
      if (stopped || options.busy() || now() < retryAt) return
      const state = await StorageFormatV3State.read(store)
      if (!state || state.phase !== "reclaim" || state.paused) return
      const filename = store.sqliteFilename
      if (!filename) return
      const disk = await fs.statfs(path.dirname(filename), { bigint: true })
      if (stopped || options.busy() || disk.bavail * disk.bsize < 1024n ** 3n) return
      if ((await store.walPressure()) > 256 * 1024 ** 2 || stopped || options.busy()) return
      const next = await pass(store)
      failures = next?.reclaimError ? failures + 1 : 0
      retryAt = failures ? now() + Math.min(900_000, 60_000 * 2 ** Math.min(failures - 1, 4)) : 0
    }
    const timer = setInterval(() => {
      if (running || stopped) return
      running = tick()
        .catch((error) => {
          failures++
          retryAt = now() + Math.min(900_000, 60_000 * 2 ** Math.min(failures - 1, 4))
          log.warn("background reclamation deferred", { errorName: error instanceof Error ? error.name : "unknown" })
        })
        .finally(() => {
          running = undefined
        })
    }, options.intervalMs ?? 60_000)
    timer.unref()
    const stop = async () => {
      stopped = true
      clearInterval(timer)
      await running
      if (jobs.get(store)?.stop === stop) jobs.delete(store)
    }
    jobs.set(store, { stop })
    return stop
  }
}
