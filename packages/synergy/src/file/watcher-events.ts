import path from "path"
import { AsyncLocalStorage } from "node:async_hooks"
import { FileIgnore } from "./ignore"
import { RuntimeReloadPath } from "../config/reload-path"

export namespace FileWatcherEvents {
  export type WorkspaceEvent = "added" | "changed" | "deleted" | "renamed"
  export type WorkspaceChange = { path: string; event: WorkspaceEvent; oldPath?: string }
  export type RawEvent = { type: "create" | "update" | "delete"; path: string }
  export type PathPlatform = "win32" | "posix"

  // Native subscribe timeout by platform. Linux inotify tree scans cannot be
  // cancelled: abandoning one at a generic timeout lets a retry overlap the
  // still-running native scan, and a scan that later fails mid-way leaks its
  // partial watches into the shared backend. Linux therefore waits for the
  // attempt to settle; the other platforms keep the bounded timeout with
  // unsubscribe-on-timeout cleanup.
  const SUBSCRIBE_TIMEOUT_MS = 10_000

  const PROJECT_RUNTIME_IGNORES = ["node_modules", "worktrees", "cache", "data", "log", "logs", "state", "tmp", "temp"]

  // Provenance: @parcel/watcher v2.5.6 wrapper.js / Watcher.cc ignore
  // semantics; the authoritative cited contract lives beside FileIgnore.PATTERNS.
  // Local adaptation: emit the same plain-name + `**/<name>/**` pair so nested
  // runtime directories (.synergy/worktrees, caches) prune at any depth.
  function recursiveDirectoryIgnores(directories: string[]) {
    return directories.flatMap((directory) => [directory, `**/${directory}/**`])
  }

  export function workspaceSubscriptionIgnores(extra: string[]) {
    return [...new Set([...FileIgnore.PATTERNS, ...recursiveDirectoryIgnores([".synergy"]), ...extra])]
  }

  export function projectRuntimeSubscriptionIgnores() {
    return recursiveDirectoryIgnores(PROJECT_RUNTIME_IGNORES)
  }

  /**
   * Terminal only when Linux inotify watch capacity is exhausted. A full
   * kernel watch table cannot clear while the process runs, so retrying only
   * repeats the native allocation that failed. Recoverable inotify failures
   * (permission changes, subtrees disappearing mid-scan) must stay retryable,
   * and the 10s subscribe timeout no longer occurs on Linux (the native
   * attempt is awaited to settle), so neither is classified as terminal.
   */
  export function isLinuxInotifyTerminalError(error: unknown, platform = process.platform) {
    if (platform !== "linux") return false
    const code =
      typeof error === "object" && error !== null && "code" in error ? String((error as { code?: unknown }).code) : ""
    const message = error instanceof Error ? error.message : String(error)
    return code === "ENOSPC" || /no space left on device/i.test(message)
  }

  // Process-wide Linux inotify capacity breaker. The kernel watch budget is
  // shared by every subscription in this process (and by sibling processes of
  // the same user); once one subscription exhausts it, any further native scan
  // can fail before registration and leak its partial tree into the shared
  // backend. A single ENOSPC therefore disables further Linux watcher startup
  // until an explicit FileWatcher.reload() (which resets the breaker) or a
  // process restart — see the Linux watcher recovery decision record.
  let linuxInotifyCapacityTripped = false

  export function isLinuxInotifyCapacityTripped() {
    return linuxInotifyCapacityTripped
  }

  export function tripLinuxInotifyCapacity() {
    linuxInotifyCapacityTripped = true
  }

  export function resetLinuxInotifyCapacity() {
    linuxInotifyCapacityTripped = false
  }

  /** Terminal error shape for refusing a new subscribe after a process-wide trip. */
  export function linuxInotifyCapacityError() {
    return Object.assign(
      new Error("Linux inotify watch capacity exhausted; watcher disabled until reload or restart"),
      {
        code: "ENOSPC",
      },
    )
  }

  export function isProjectRuntimeInput(file: string) {
    return (
      RuntimeReloadPath.detectScopeForFile(file) === "project" &&
      RuntimeReloadPath.detectTargetsForFile(file).length > 0
    )
  }

  function platformKind(): PathPlatform {
    return process.platform === "win32" ? "win32" : "posix"
  }

  export function normalizePath(input: string, platform: PathPlatform = platformKind()) {
    if (platform === "win32") return path.win32.normalize(input.replaceAll("/", "\\")).toLowerCase()
    return path.posix.normalize(input)
  }

  function parentOf(input: string, platform: PathPlatform) {
    const normalized = normalizePath(input, platform)
    return platform === "win32" ? path.win32.dirname(normalized) : path.posix.dirname(normalized)
  }

  export function normalize(events: RawEvent[], platform: PathPlatform = platformKind()): WorkspaceChange[] {
    const deletes = events.filter((event) => event.type === "delete")
    const creates = events.filter((event) => event.type === "create")
    const updates = events.filter((event) => event.type === "update")
    const usedDeletes = new Set<number>()
    const result: WorkspaceChange[] = []

    for (const create of creates) {
      const deleteIndex = deletes.findIndex((item, index) => {
        if (usedDeletes.has(index)) return false
        return normalizePath(item.path, platform) === normalizePath(create.path, platform)
      })
      if (deleteIndex !== -1) {
        usedDeletes.add(deleteIndex)
        result.push({ path: create.path, event: "changed" })
        continue
      }

      const renameIndex = deletes.findIndex((item, index) => {
        if (usedDeletes.has(index)) return false
        return parentOf(item.path, platform) === parentOf(create.path, platform)
      })
      if (renameIndex === -1) {
        result.push({ path: create.path, event: "added" })
        continue
      }
      usedDeletes.add(renameIndex)
      result.push({ path: create.path, event: "renamed", oldPath: deletes[renameIndex]!.path })
    }

    for (const update of updates) result.push({ path: update.path, event: "changed" })
    for (const [index, deleted] of deletes.entries()) {
      if (!usedDeletes.has(index)) result.push({ path: deleted.path, event: "deleted" })
    }
    return result
  }

  function merge(previous: WorkspaceChange | undefined, next: WorkspaceChange): WorkspaceChange | undefined {
    if (!previous) return next
    if (previous.event === "added" && next.event === "changed") return previous
    if (previous.event === "added" && next.event === "deleted") return undefined
    if (previous.event === "deleted" && next.event === "added") return { ...next, event: "changed" }
    if (previous.event === "renamed") return { ...next, event: "renamed", oldPath: previous.oldPath }
    return next
  }

  export function createDrain(input: {
    debounceMs: number
    maxPending: number
    platform?: PathPlatform
    process: (batch: WorkspaceChange[]) => Promise<void>
    overflow: () => Promise<void>
  }) {
    const pending = new Map<string, WorkspaceChange>()
    const idleWaiters = new Set<() => void>()
    let timer: ReturnType<typeof setTimeout> | undefined
    let draining: Promise<void> | undefined
    let overflowed = false
    let disposed = false

    const settled = () => !timer && !draining && pending.size === 0 && !overflowed
    const resolveIdle = () => {
      if (!settled()) return
      for (const resolve of idleWaiters) resolve()
      idleWaiters.clear()
    }

    const run = () => {
      if (disposed || draining) return
      draining = Promise.resolve()
        .then(async () => {
          while (!disposed && (overflowed || pending.size > 0)) {
            if (overflowed) {
              overflowed = false
              pending.clear()
              await input.overflow()
              continue
            }
            const batch = [...pending.values()]
            pending.clear()
            await input.process(batch)
          }
        })
        .finally(() => {
          draining = undefined
          if (!disposed && (overflowed || pending.size > 0)) run()
          resolveIdle()
        })
    }

    const schedule = () => {
      if (disposed || timer || draining) return
      timer = setTimeout(() => {
        timer = undefined
        run()
      }, input.debounceMs)
    }

    return {
      enqueue(events: WorkspaceChange[]) {
        if (disposed || overflowed) return
        for (const event of events) {
          const key = normalizePath(event.path, input.platform)
          const previous = pending.get(key)
          if (previous?.event === "renamed" && event.event === "deleted") {
            pending.clear()
            overflowed = true
            break
          }
          const next = merge(previous, event)
          if (next) pending.set(key, next)
          else pending.delete(key)
          if (pending.size <= input.maxPending) continue
          pending.clear()
          overflowed = true
          break
        }
        schedule()
      },
      resync() {
        if (disposed) return
        pending.clear()
        overflowed = true
        schedule()
      },
      pending() {
        return pending.size
      },
      idle() {
        if (settled()) return Promise.resolve()
        return new Promise<void>((resolve) => idleWaiters.add(resolve))
      },
      async dispose() {
        disposed = true
        if (timer) clearTimeout(timer)
        timer = undefined
        pending.clear()
        overflowed = false
        await draining
        resolveIdle()
      },
    }
  }

  /** Linux awaits the native attempt to settle; other platforms keep the 10s bound. */
  export function nativeSubscribeTimeoutMs(platform: NodeJS.Platform = process.platform) {
    return platform === "linux" ? undefined : SUBSCRIBE_TIMEOUT_MS
  }

  /** Runs one task at a time, in submission order, regardless of caller concurrency. */
  export function createSerialQueue() {
    let tail: Promise<void> = Promise.resolve()
    return function enqueue<T>(task: () => Promise<T>): Promise<T> {
      const run = tail.then(task)
      tail = run.then(
        () => undefined,
        () => undefined,
      )
      return run
    }
  }

  export function createSubscriptionRecovery<T>(input: {
    connect: (context: {
      generation: number
      isCurrent: () => boolean
      fail: (error: unknown) => Promise<void>
    }) => Promise<T>
    disconnect: (subscription: T) => Promise<void>
    onError: (error: unknown) => void | Promise<void>
    shouldRetry?: (error: unknown) => boolean
    retryMs?: number
  }) {
    const retryMs = input.retryMs ?? 1_000
    let current: T | undefined
    let connecting: Promise<void> | undefined
    let handlingFailure: Promise<void> | undefined
    let disconnecting: Promise<void> | undefined
    let disposing: Promise<void> | undefined
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    let generation = 0
    let started = false
    let disposed = false
    let retryBlocked = false
    const reportContext = new AsyncLocalStorage<symbol>()

    const report = async (error: unknown) => {
      const context = Symbol()
      await reportContext.run(context, async () => {
        try {
          await input.onError(error)
        } catch {
          // Error reporting must not prevent a failed watcher from being retried.
        }
      })
    }

    const scheduleRetry = () => {
      if (disposed || retryBlocked || retryTimer || current || connecting) return
      retryTimer = setTimeout(() => {
        retryTimer = undefined
        void connect()
      }, retryMs)
    }

    const disconnect = async (subscription: T) => {
      const task = (async () => {
        try {
          await input.disconnect(subscription)
        } catch (error) {
          await report(error)
        }
      })()
      disconnecting = task
      try {
        await task
      } finally {
        if (disconnecting === task) disconnecting = undefined
      }
    }

    const fail = (error: unknown, expectedGeneration?: number) => {
      if (disposed || (expectedGeneration !== undefined && expectedGeneration !== generation)) return Promise.resolve()
      if (input.shouldRetry?.(error) === false) retryBlocked = true
      generation += 1
      if (handlingFailure) return handlingFailure

      const task = (async () => {
        const subscription = current
        current = undefined
        if (subscription) await disconnect(subscription)
        await report(error)
        if (!retryBlocked) scheduleRetry()
      })()
      let settled: Promise<void>
      settled = task.finally(() => {
        if (handlingFailure === settled) handlingFailure = undefined
      })
      handlingFailure = settled
      return settled
    }

    async function connect() {
      if (disposed || current || connecting) return
      const attempt = ++generation
      const task = (async () => {
        try {
          const subscription = await input.connect({
            generation: attempt,
            isCurrent: () => !disposed && attempt === generation,
            fail: (error) => fail(error, attempt),
          })
          if (disposed || attempt !== generation) {
            await disconnect(subscription)
            return
          }
          current = subscription
        } catch (error) {
          await fail(error, attempt)
        }
      })()
      connecting = task
      try {
        await task
      } finally {
        if (connecting === task) connecting = undefined
        if (!disposed && !retryBlocked && !current && !handlingFailure) scheduleRetry()
      }
    }

    return {
      async start() {
        if (started || disposed) return
        started = true
        await connect()
      },
      fail,
      async dispose() {
        const reentrant = reportContext.getStore() !== undefined
        if (disposed) {
          if (reentrant) return
          await disposing
          return
        }
        disposed = true
        generation += 1
        if (retryTimer) clearTimeout(retryTimer)
        retryTimer = undefined
        const task = (async () => {
          const subscription = current
          current = undefined
          if (subscription) await disconnect(subscription)
          if (!reentrant) {
            await disconnecting
            await handlingFailure
          }
        })()
        disposing = task
        await task
      },
      active() {
        return current !== undefined
      },
    }
  }
}
