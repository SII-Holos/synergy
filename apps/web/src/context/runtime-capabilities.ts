import { createSignal, untrack } from "solid-js"
import type { RuntimeCapabilities } from "@ericsanchezok/synergy-sdk"

export function createRuntimeCapabilities(discover: () => Promise<RuntimeCapabilities>) {
  const [current, setCurrent] = createSignal<RuntimeCapabilities>()
  let epoch = 0
  let pending: Promise<void> | undefined

  function load(): Promise<void> {
    if (untrack(current)) return Promise.resolve()
    if (pending) return pending
    const requestedEpoch = epoch
    const request = discover()
      .then(async (value) => {
        if (requestedEpoch !== epoch) return load()
        if (value.apiVersion !== 1) throw new Error("Unsupported runtime capabilities API")
        setCurrent(value)
      })
      .finally(() => {
        if (pending === request) pending = undefined
      })
    pending = request
    return request
  }

  return {
    current,
    has: (id: string) => current()?.components.some((component) => component.id === id) ?? false,
    load,
    reset() {
      epoch++
      pending = undefined
      setCurrent(undefined)
    },
  }
}
