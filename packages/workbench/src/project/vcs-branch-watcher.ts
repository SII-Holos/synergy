import path from "path"

export namespace VcsBranchWatcher {
  export interface Watcher {
    start(): Promise<string | undefined>
    current(): string | undefined
    notify(file: string): void
    idle(): Promise<void>
    dispose(): Promise<void>
  }

  export function create(input: {
    debounceMs: number
    resolve: () => Promise<string | undefined>
    onChange: (branch: string | undefined, previous: string | undefined) => Promise<void> | void
  }): Watcher {
    let branch: string | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    let inFlight: Promise<void> | undefined
    let refreshPending = false
    let disposed = false
    const idleWaiters = new Set<() => void>()

    const settled = () => !timer && !inFlight
    const resolveIdle = () => {
      if (!settled()) return
      for (const resolve of idleWaiters) resolve()
      idleWaiters.clear()
    }

    const refresh = () => {
      if (disposed || inFlight) return
      inFlight = Promise.resolve()
        .then(async () => {
          while (!disposed && refreshPending) {
            refreshPending = false
            const previous = branch
            const next = await input.resolve()
            branch = next
            if (next !== previous) await input.onChange(next, previous)
          }
        })
        .finally(() => {
          inFlight = undefined
          if (!disposed && refreshPending) refresh()
          resolveIdle()
        })
    }

    return {
      async start() {
        branch = await input.resolve()
        return branch
      },
      current() {
        return branch
      },
      notify(file) {
        if (disposed || path.basename(file) !== "HEAD") return
        refreshPending = true
        if (timer || inFlight) return
        timer = setTimeout(() => {
          timer = undefined
          refresh()
        }, input.debounceMs)
      },
      idle() {
        if (settled()) return Promise.resolve()
        return new Promise<void>((resolve) => idleWaiters.add(resolve))
      },
      async dispose() {
        disposed = true
        if (timer) clearTimeout(timer)
        refreshPending = false
        timer = undefined
        await inFlight
        resolveIdle()
      },
    }
  }
}
