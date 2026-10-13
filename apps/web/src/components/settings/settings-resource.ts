import { createEffect, createSignal, getOwner, onCleanup, untrack } from "solid-js"

export interface SettingsResourceState {
  ready(): boolean
  loading(): boolean
  error(): unknown
  refetch(): Promise<unknown>
  retry(): Promise<unknown>
}

export function createSettingsResource<T>(
  loader: () => Promise<T>,
  needed: () => boolean = () => true,
  ownerKey?: () => unknown,
) {
  const [data, setData] = createSignal<T>()
  const [ready, setReady] = createSignal(false)
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal<unknown>()
  let owner = untrack(() => ownerKey?.())
  let generation = 0
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
    const token = generation
    const request = Promise.resolve()
      .then(loader)
      .then((value) => {
        if (!disposed && token === generation) {
          setData(() => value)
          setReady(true)
          setError(undefined)
        }
        return value
      })
      .catch((cause: unknown) => {
        if (!disposed && token === generation) setError(() => cause)
        return undefined
      })
      .finally(() => {
        if (pending === request) pending = undefined
        if (!disposed && token === generation) setLoading(false)
      })
    pending = request
    return request
  }

  const refetch = () => (requested ? retry() : Promise.resolve(undefined))
  createEffect(() => {
    const nextOwner = ownerKey?.()
    if (owner !== nextOwner) {
      owner = nextOwner
      generation++
      pending = undefined
      requested = false
      setData(undefined)
      setReady(false)
      setLoading(false)
      setError(undefined)
    }
    if (needed() && !requested) untrack(() => void retry())
  })
  return [data, { ready, loading, error, refetch, retry }] as const
}
