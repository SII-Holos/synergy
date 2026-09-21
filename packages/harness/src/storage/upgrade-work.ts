import fs from "node:fs/promises"
import path from "node:path"
import { Context } from "../util/context"
import { Storage } from "./storage"
import { AtomicFile } from "./atomic-file"
import { StorageBusyError } from "./errors"

interface Work {
  background: boolean
  signal?: AbortSignal
  sessionID?: string
}

const context = Context.create<Work>("upgrade-work")
const state = Storage.state(() => ({
  paused: false,
  stopping: false,
  checkedAt: -Infinity,
  reason: undefined as "user" | "foreground" | "disk" | "wal" | undefined,
  busy: (): boolean => false,
  capacityAt: -Infinity,
  capacityBytes: 0,
  yieldedAt: -Infinity,
  walBytes: 0,
  priority: new Map<string, number>(),
  controllers: new Map<AbortController, { background: boolean; sessionID?: string }>(),
  foregroundOwners: 0,
  compression: 0,
}))

function pausePath() {
  return path.join(Storage.current().artifactDirectory, "storage", "compat-pause")
}

async function wait(signal?: AbortSignal) {
  signal?.throwIfAborted()
  await new Promise<void>((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener("abort", abort)
      resolve()
    }
    const timer = setTimeout(finish, 50)
    const abort = () => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", abort)
      reject(signal?.reason)
    }
    signal?.addEventListener("abort", abort, { once: true })
  })
}

// Adapted scheduling policy: GitLab batched background migrations (health throttling and bounded batches).
// https://docs.gitlab.com/development/database/batched_background_migrations/
// SQLite still has one writer; WAL pressure must yield to foreground work: https://www.sqlite.org/wal.html
export namespace UpgradeWork {
  export function run<T>(work: Work, body: () => Promise<T>) {
    return context.provide(work, async () => {
      try {
        return await body()
      } catch (error) {
        work.signal?.throwIfAborted()
        throw error
      }
    })
  }

  export async function ownerSlot<T>(background: boolean, body: () => Promise<T>) {
    if (background) return body()
    const current = state()
    while (current.foregroundOwners >= 2) await wait(signal())
    signal()?.throwIfAborted()
    current.foregroundOwners++
    try {
      return await body()
    } finally {
      current.foregroundOwners--
    }
  }

  export async function compress<T>(body: () => Promise<T>) {
    if (!context.tryUse()) return body()
    const current = state()
    while (current.compression >= 2) await wait(signal())
    signal()?.throwIfAborted()
    current.compression++
    try {
      return await body()
    } finally {
      current.compression--
    }
  }

  export function signal() {
    return context.tryUse()?.signal
  }

  export function priority(sessionID: string) {
    const current = state()
    current.priority.set(sessionID, (current.priority.get(sessionID) ?? 0) + 1)
    for (const [controller, work] of current.controllers)
      if (work.background && !current.priority.has(work.sessionID ?? ""))
        controller.abort(new DOMException("Background preparation yielded to a requested Session", "AbortError"))
    return () => {
      const count = (current.priority.get(sessionID) ?? 1) - 1
      if (count) current.priority.set(sessionID, count)
      else current.priority.delete(sessionID)
    }
  }

  export function controller(background = false, sessionID?: string) {
    const current = state()
    const controller = new AbortController()
    if (current.stopping) controller.abort(new DOMException("Upgrade is stopping", "AbortError"))
    current.controllers.set(controller, { background, sessionID })
    const timer = background
      ? setInterval(() => {
          void status()
            .then((value) => {
              if (
                !current.priority.has(sessionID ?? "") &&
                (value.paused || current.busy() || current.priority.size > 0)
              )
                controller.abort(
                  new DOMException("Background preparation yielded at its durable checkpoint", "AbortError"),
                )
            })
            .catch((error) => controller.abort(error))
        }, 100)
      : undefined
    timer?.unref()
    return {
      controller,
      dispose: () => {
        clearInterval(timer)
        current.controllers.delete(controller)
      },
    }
  }

  export function stop() {
    state().stopping = true
    for (const controller of state().controllers.keys())
      controller.abort(new DOMException("Upgrade paused for shutdown", "AbortError"))
  }

  export function activity(busy: () => boolean) {
    state().stopping = false
    state().busy = busy
  }

  export async function control(action: "pause" | "resume") {
    if (action === "pause") await AtomicFile.writeFileAtomic(pausePath(), "paused\n", { private: true, durable: true })
    else await fs.rm(pausePath(), { force: true })
    state().paused = action === "pause"
    if (action === "pause")
      for (const [controller, work] of state().controllers)
        if (work.background && !state().priority.has(work.sessionID ?? ""))
          controller.abort(new DOMException("Background preparation paused", "AbortError"))
    state().checkedAt = -Infinity
    return status()
  }

  export async function status() {
    const current = state()
    if (performance.now() - current.checkedAt >= 1000) {
      const paused = await fs.stat(pausePath()).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined
        throw error
      })
      current.paused = Boolean(paused)
      current.checkedAt = performance.now()
    }
    return { paused: current.paused, pauseReason: current.paused ? ("user" as const) : current.reason }
  }

  export async function checkpoint(bytes = 0) {
    const work = context.tryUse()
    work?.signal?.throwIfAborted()
    if (!work) return
    const current = state()
    let capacityChecked = false
    for (;;) {
      work.signal?.throwIfAborted()
      const background = work.background && !current.priority.has(work.sessionID ?? "")
      const status = await UpgradeWork.status()
      if (background && (status.paused || current.busy() || current.priority.size > 0)) {
        current.reason = status.paused ? "user" : "foreground"
        await wait(work.signal)
        continue
      }
      if (!capacityChecked && (performance.now() - current.capacityAt >= 1000 || bytes > current.capacityBytes)) {
        const disk = await fs.statfs(Storage.current().artifactDirectory, { bigint: true })
        if (disk.bavail * disk.bsize < BigInt(Math.ceil(1024 ** 3 + bytes * 2))) {
          current.reason = "disk"
          throw new StorageBusyError("Insufficient free space for migration and live work; free space and retry")
        }
        capacityChecked = true
        current.capacityAt = performance.now()
        current.capacityBytes = bytes
        if (background) current.walBytes = await Storage.current().store.walPressure()
      }
      if (background && current.walBytes > 256 * 1024 ** 2) {
        current.reason = "wal"
        await wait(work.signal)
        capacityChecked = false
        continue
      }
      current.reason = undefined
      if (performance.now() - current.yieldedAt >= 25) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0))
        current.yieldedAt = performance.now()
      }
      return
    }
  }
}
