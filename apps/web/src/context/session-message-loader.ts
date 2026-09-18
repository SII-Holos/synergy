export type SessionMessageLoadPhase = "idle" | "loading" | "ready" | "refreshing" | "error"

export type SessionMessageLoadState = {
  phase: SessionMessageLoadPhase
  generation: number
  hasSnapshot: boolean
  error?: string
}

export type SessionMessageApplyResult = "applied" | "superseded"

type LoadOptions<TInput> = {
  force?: boolean
  hasSnapshot?: boolean
  input?: TInput
}

type LoaderOptions<TResult, TInput> = {
  request: (sessionID: string, signal: AbortSignal, input: TInput | undefined) => Promise<TResult>
  apply: (sessionID: string, result: TResult, input: TInput | undefined) => SessionMessageApplyResult | void
  errorMessage: (error: unknown) => string
  onState?: (sessionID: string, state: SessionMessageLoadState) => void
  /** Injected pause between superseded attempts; defaults to a real timer. */
  wait?: (ms: number) => Promise<void>
}

type ActiveRequest = {
  generation: number
  controller: AbortController
  promise: Promise<void>
}

const idleState = (): SessionMessageLoadState => ({ phase: "idle", generation: 0, hasSnapshot: false })

const MAX_SUPERSEDED_ATTEMPTS = 4
const SUPERSEDED_BACKOFF_MS = 100

const defaultWait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

class SessionMessageSnapshotSupersededError extends Error {
  constructor() {
    super("Message snapshot was superseded while loading")
  }
}

export function createSessionMessageLoader<TResult, TInput = void>(options: LoaderOptions<TResult, TInput>) {
  const states = new Map<string, SessionMessageLoadState>()
  const active = new Map<string, ActiveRequest>()
  const wait = options.wait ?? defaultWait
  // Doubling pause after each superseded attempt: event bursts that keep
  // rejecting a page typically settle within a few hundred milliseconds.
  const supersededBackoff = (failures: number) => SUPERSEDED_BACKOFF_MS * 2 ** (failures - 1)

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
      const runAttempts = async () => {
        let failures = 0
        while (failures < MAX_SUPERSEDED_ATTEMPTS) {
          if (failures > 0) {
            await wait(supersededBackoff(failures))
            if (active.get(sessionID)?.controller !== controller) return
          }
          const result = await options.request(sessionID, controller.signal, loadOptions?.input)
          if (active.get(sessionID)?.controller !== controller) return
          const applied = options.apply(sessionID, result, loadOptions?.input)
          if (applied !== "superseded") {
            publish(sessionID, { phase: "ready", generation, hasSnapshot: true })
            return
          }
          failures++
        }
        throw new SessionMessageSnapshotSupersededError()
      }

      try {
        try {
          await runAttempts()
          return
        } catch (error) {
          // A first view with no previous snapshot would otherwise strand the
          // user on a blank transcript behind the retry button; restart the
          // whole attempt window once. Loads with a visible snapshot keep the
          // error so live state is never flashed away.
          if (error instanceof SessionMessageSnapshotSupersededError && !hasSnapshot) {
            publish(sessionID, { phase: "loading", generation, hasSnapshot })
            await wait(supersededBackoff(MAX_SUPERSEDED_ATTEMPTS))
            if (active.get(sessionID)?.controller !== controller) return
            await runAttempts()
            return
          }
          throw error
        }
      } catch (error) {
        if (active.get(sessionID)?.controller !== controller) return
        publish(sessionID, {
          phase: "error",
          generation,
          hasSnapshot,
          error: options.errorMessage(error),
        })
        throw error
      } finally {
        if (active.get(sessionID)?.controller === controller) active.delete(sessionID)
      }
    })()

    active.set(sessionID, { generation, controller, promise })
    return promise
  }

  const release = (sessionID: string) => {
    const request = active.get(sessionID)
    active.delete(sessionID)
    states.delete(sessionID)
    request?.controller.abort()
  }

  const dispose = () => {
    for (const request of active.values()) request.controller.abort()
    active.clear()
  }

  return { load, state, release, dispose }
}
