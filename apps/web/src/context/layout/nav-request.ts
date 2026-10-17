export type NavRequestState = { loading: boolean; loaded: boolean; error: boolean }

export function createNavRequest<Owner>(options: { owner(): Owner; publish(state: NavRequestState): void }) {
  let generation = 0
  let disposed = false
  let controller: AbortController | undefined
  let state: NavRequestState = { loading: false, loaded: false, error: false }
  const publish = (next: NavRequestState) => {
    state = next
    options.publish(next)
  }
  return {
    async run<T>(fetch: (owner: Owner, signal: AbortSignal) => Promise<T>, apply: (value: T) => void) {
      if (disposed) return
      const owner = options.owner()
      const current = ++generation
      controller?.abort()
      controller = new AbortController()
      const accepted = () => !disposed && current === generation && owner === options.owner()
      publish({ ...state, loading: true, error: false })
      try {
        const value = await fetch(owner, controller.signal)
        if (!accepted()) return
        apply(value)
        publish({ loading: false, loaded: true, error: false })
      } catch {
        if (accepted()) publish({ ...state, loading: false, error: true })
      }
    },
    dispose() {
      disposed = true
      generation++
      controller?.abort()
    },
  }
}
