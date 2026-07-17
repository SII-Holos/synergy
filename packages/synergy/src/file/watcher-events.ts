import path from "path"
import { FileIgnore } from "./ignore"
import { RuntimeReloadPath } from "../runtime/reload-path"

export namespace FileWatcherEvents {
  export type WorkspaceEvent = "added" | "changed" | "deleted" | "renamed"
  export type WorkspaceChange = { path: string; event: WorkspaceEvent; oldPath?: string }
  export type RawEvent = { type: "create" | "update" | "delete"; path: string }

  const PROJECT_RUNTIME_IGNORES = ["node_modules", "worktrees", "cache", "data", "log", "logs", "state", "tmp", "temp"]

  export function workspaceSubscriptionIgnores(extra: string[]) {
    return [...new Set([...FileIgnore.PATTERNS, ".synergy", ...extra])]
  }

  export function projectRuntimeSubscriptionIgnores() {
    return [...PROJECT_RUNTIME_IGNORES]
  }

  export function isProjectRuntimeInput(file: string) {
    return (
      RuntimeReloadPath.detectScopeForFile(file) === "project" &&
      RuntimeReloadPath.detectTargetsForFile(file).length > 0
    )
  }

  function parentOf(input: string) {
    return path.dirname(input)
  }

  export function normalize(events: RawEvent[]): WorkspaceChange[] {
    const deletes = events.filter((event) => event.type === "delete")
    const creates = events.filter((event) => event.type === "create")
    const updates = events.filter((event) => event.type === "update")
    const usedDeletes = new Set<number>()
    const result: WorkspaceChange[] = []

    for (const create of creates) {
      const deleteIndex = deletes.findIndex((item, index) => {
        if (usedDeletes.has(index)) return false
        if (parentOf(item.path) === parentOf(create.path)) return true
        return deletes.length === 1 && creates.length === 1
      })
      if (deleteIndex === -1) {
        result.push({ path: create.path, event: "added" })
        continue
      }
      usedDeletes.add(deleteIndex)
      result.push({ path: create.path, event: "renamed", oldPath: deletes[deleteIndex]!.path })
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
    return next
  }

  export function createDrain(input: {
    debounceMs: number
    maxPending: number
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
          const next = merge(pending.get(event.path), event)
          if (next) pending.set(event.path, next)
          else pending.delete(event.path)
          if (pending.size <= input.maxPending) continue
          pending.clear()
          overflowed = true
          break
        }
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
}
