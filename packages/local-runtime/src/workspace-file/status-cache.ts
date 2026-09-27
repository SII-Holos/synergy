export namespace WorkspaceFileStatusCache {
  export interface Cache<T> {
    get(options?: { force?: boolean }): Promise<T>
    invalidate(): void
  }

  export function create<T>(input: { ttlMs: number; build: () => Promise<T>; now?: () => number }): Cache<T> {
    const now = input.now ?? Date.now
    let value: T | undefined
    let hasValue = false
    let fetchedAt = 0
    let invalidationGeneration = 0
    let builtGeneration = -1
    let inFlight: Promise<T> | undefined

    const fresh = () => hasValue && builtGeneration === invalidationGeneration && now() - fetchedAt <= input.ttlMs

    const run = async () => {
      let allowFollowUp = true
      while (true) {
        const generation = invalidationGeneration
        const next = await input.build()
        value = next
        hasValue = true
        fetchedAt = now()
        builtGeneration = generation

        if (!allowFollowUp || invalidationGeneration === generation) return next
        allowFollowUp = false
      }
    }

    return {
      get(options) {
        if (inFlight) return inFlight
        if (!options?.force && fresh()) return Promise.resolve(value as T)
        inFlight = run().finally(() => {
          inFlight = undefined
        })
        return inFlight
      },
      invalidate() {
        invalidationGeneration += 1
      },
    }
  }
}
