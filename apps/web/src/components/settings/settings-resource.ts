import { createEffect, createSignal, getOwner, onCleanup, untrack } from "solid-js"

export interface SettingsResourceState {
  ready(): boolean
  loading(): boolean
  error(): unknown
  refetch(): Promise<unknown>
  retry(): Promise<unknown>
}

export function createSettingsResource<T>(loader: () => Promise<T>, needed: () => boolean = () => true) {
  const [data, setData] = createSignal<T>()
  const [ready, setReady] = createSignal(false)
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal<unknown>()
  let requested = false
  let disposed = false
  let pending: Promise<T | undefined> | undefined
  if (getOwner())
    onCleanup(() => {
      disposed = true
    })

  function retry(): Promise<T | undefined> {
    if (pending) return pending
    requested = true
    setLoading(true)
    pending = Promise.resolve()
      .then(loader)
      .then((value) => {
        if (!disposed) {
          setData(() => value)
          setReady(true)
          setError(undefined)
        }
        return value
      })
      .catch((cause: unknown) => {
        if (!disposed) setError(() => cause)
        return undefined
      })
      .finally(() => {
        pending = undefined
        if (!disposed) setLoading(false)
      })
    return pending
  }

  const refetch = () => (requested ? retry() : Promise.resolve(undefined))
  createEffect(() => {
    if (needed() && !requested) untrack(() => void retry())
  })
  return [data, { ready, loading, error, refetch, retry }] as const
}
