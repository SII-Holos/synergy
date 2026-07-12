export type SessionMessageLoadPhase = "idle" | "loading" | "ready" | "refreshing" | "error"

export type SessionMessageLoadState = {
  phase: SessionMessageLoadPhase
  generation: number
  hasSnapshot: boolean
  error?: string
}

type LoadOptions<TInput> = {
  force?: boolean
  hasSnapshot?: boolean
  input?: TInput
}

type LoaderOptions<TResult, TInput> = {
  request: (sessionID: string, signal: AbortSignal, input: TInput | undefined) => Promise<TResult>
  apply: (sessionID: string, result: TResult, input: TInput | undefined) => void
  errorMessage: (error: unknown) => string
  onState?: (sessionID: string, state: SessionMessageLoadState) => void
}

type ActiveRequest = {
  generation: number
  controller: AbortController
  promise: Promise<void>
}

const idleState = (): SessionMessageLoadState => ({ phase: "idle", generation: 0, hasSnapshot: false })

export function createSessionMessageLoader<TResult, TInput = void>(options: LoaderOptions<TResult, TInput>) {
  const states = new Map<string, SessionMessageLoadState>()
  const active = new Map<string, ActiveRequest>()

  const publish = (sessionID: string, state: SessionMessageLoadState) => {
    states.set(sessionID, state)
    options.onState?.(sessionID, state)
  }

  const state = (sessionID: string) => states.get(sessionID) ?? idleState()

  const load = (sessionID: string, loadOptions?: LoadOptions<TInput>) => {
    const pending = active.get(sessionID)
    if (pending && !loadOptions?.force) return pending.promise
    if (pending) pending.controller.abort()

    const previous = state(sessionID)
    const generation = previous.generation + 1
    const hasSnapshot = loadOptions?.hasSnapshot ?? previous.hasSnapshot
    const controller = new AbortController()
    publish(sessionID, {
      phase: hasSnapshot ? "refreshing" : "loading",
      generation,
      hasSnapshot,
    })

    const promise = (async () => {
      try {
        const result = await options.request(sessionID, controller.signal, loadOptions?.input)
        if (active.get(sessionID)?.generation !== generation) return
        options.apply(sessionID, result, loadOptions?.input)
        publish(sessionID, { phase: "ready", generation, hasSnapshot: true })
      } catch (error) {
        if (active.get(sessionID)?.generation !== generation) return
        publish(sessionID, {
          phase: "error",
          generation,
          hasSnapshot,
          error: options.errorMessage(error),
        })
        throw error
      } finally {
        if (active.get(sessionID)?.generation === generation) active.delete(sessionID)
      }
    })()

    active.set(sessionID, { generation, controller, promise })
    return promise
  }

  const dispose = () => {
    for (const request of active.values()) request.controller.abort()
    active.clear()
  }

  return { load, state, dispose }
}
