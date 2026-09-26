import { createEffect, on, onCleanup, type Accessor } from "solid-js"
import { createStore, reconcile } from "solid-js/store"

export function createLibraryCollection<T>(
  key: Accessor<string>,
  load: (key: string, signal: AbortSignal) => Promise<T[]>,
) {
  const empty: T[] = []
  const [state, setState] = createStore<{ key: string; items: T[]; loading: boolean; error?: unknown }>({
    key: "",
    items: [],
    loading: false,
  })
  let controller: AbortController | undefined
  let pending: Promise<void> | undefined
  let version = 0
  let disposed = false
  onCleanup(() => {
    disposed = true
    version++
    controller?.abort()
  })

  function refresh(): Promise<void> {
    if (disposed) return Promise.resolve()
    const request = key()
    if (pending && state.key === request) return pending
    const generation = ++version
    controller?.abort()
    controller = new AbortController()
    const signal = controller.signal
    if (state.key !== request) setState(reconcile({ key: request, items: [], loading: true }))
    else setState({ loading: true, error: undefined })
    pending = Promise.resolve()
      .then(() => load(request, signal))
      .then((items) => {
        if (generation === version) setState(reconcile({ key: request, items, loading: false }))
      })
      .catch((error) => {
        if (generation === version) setState({ loading: false, error })
      })
      .finally(() => {
        if (generation === version) pending = undefined
      })
    return pending
  }
  createEffect(
    on(key, () => {
      void refresh()
    }),
  )
  return {
    items: () => (state.key === key() ? state.items : empty),
    error: () => (state.key === key() ? state.error : undefined),
    loading: () => state.key !== key() || state.loading,
    refresh,
  }
}
