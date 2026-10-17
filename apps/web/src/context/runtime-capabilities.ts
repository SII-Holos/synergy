import { createSignal, untrack } from "solid-js"
import type { RuntimeCapabilities } from "@ericsanchezok/synergy-sdk"
import type { SynergyClient } from "@ericsanchezok/synergy-sdk/client"
import { retrySleep } from "@ericsanchezok/synergy-util/retry"

export async function discoverRuntimeCapabilities(
  client: SynergyClient,
  signal: AbortSignal,
): Promise<RuntimeCapabilities> {
  while (true) {
    signal.throwIfAborted()
    const result = await client.global.capabilities({ signal, throwOnError: false })
    if (result.response?.status === 503) {
      await retrySleep(500, signal)
      continue
    }
    if (result.error) throw result.error
    if (!result.data) throw new Error("Runtime capabilities response was empty")
    return result.data
  }
}

export function createRuntimeCapabilities(discover: (signal: AbortSignal) => Promise<RuntimeCapabilities>) {
  const [current, setCurrent] = createSignal<RuntimeCapabilities>()
  let epoch = 0
  let pending: Promise<void> | undefined
  let cancellation = new AbortController()
  let disposed = false

  function load(): Promise<void> {
    if (disposed) return Promise.resolve()
    if (untrack(current)) return Promise.resolve()
    if (pending) return pending
    const requestedEpoch = epoch
    const request = discover(cancellation.signal)
      .then(async (value) => {
        if (requestedEpoch !== epoch) return load()
        if (value.apiVersion !== 1 || !Array.isArray(value.features))
          throw new Error("Unsupported runtime capabilities API")
        setCurrent(value)
      })
      .catch((error) => {
        if (requestedEpoch !== epoch || disposed) return
        throw error
      })
      .finally(() => {
        if (pending === request) pending = undefined
      })
    pending = request
    return request
  }

  function reset() {
    epoch++
    cancellation.abort()
    cancellation = new AbortController()
    pending = undefined
    setCurrent(undefined)
  }
  return {
    current,
    has: (id: string) => current()?.features.includes(id) ?? false,
    load,
    reset,
    dispose() {
      disposed = true
      reset()
    },
  }
}
