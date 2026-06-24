export namespace ExecutionBudget {
  export interface Info {
    signal: AbortSignal
    pause(): void
    resume(): void
    dispose(): void
  }

  export function create(ms: number): Info {
    const controller = new AbortController()
    let remaining = Math.max(0, ms)
    let startedAt = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    let paused = true
    let disposed = false

    const clear = () => {
      if (timer === undefined) return
      clearTimeout(timer)
      timer = undefined
    }

    const abort = () => {
      clear()
      if (!controller.signal.aborted) controller.abort()
    }

    const pause = () => {
      if (paused || disposed || controller.signal.aborted) return
      remaining = Math.max(0, remaining - (Date.now() - startedAt))
      paused = true
      clear()
    }

    const resume = () => {
      if (!paused || disposed || controller.signal.aborted) return
      if (remaining <= 0) {
        abort()
        return
      }
      paused = false
      startedAt = Date.now()
      timer = setTimeout(abort, remaining)
    }

    const dispose = () => {
      disposed = true
      clear()
    }

    resume()

    return {
      signal: controller.signal,
      pause,
      resume,
      dispose,
    }
  }
}
