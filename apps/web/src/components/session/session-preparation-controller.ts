import type { StorageSessionPreparation } from "@ericsanchezok/synergy-sdk/client"

export function createSessionPreparationController(options: {
  prepare(signal: AbortSignal): Promise<StorageSessionPreparation>
  poll(signal: AbortSignal): Promise<StorageSessionPreparation>
  retry(signal: AbortSignal): Promise<StorageSessionPreparation>
  publish(value: StorageSessionPreparation): void
  failed(): void
  hidden(): boolean
  schedule?: (callback: () => void, delay: number) => () => void
}) {
  let disposed = false
  let generation = 0
  let abort: AbortController | undefined
  let cancel: (() => void) | undefined
  const schedule =
    options.schedule ??
    ((callback, delay) => {
      const timer = setTimeout(callback, delay)
      return () => clearTimeout(timer)
    })
  async function run(action: "prepare" | "poll" | "retry") {
    if (disposed) return
    const current = ++generation
    cancel?.()
    abort?.abort()
    abort = new AbortController()
    try {
      const value = await options[action](abort.signal)
      if (disposed || generation !== current) return
      options.publish(value)
      if (value.state === "pending" || value.state === "preparing")
        cancel = schedule(() => void run("poll"), options.hidden() ? 10_000 : 1000)
    } catch {
      if (!disposed && current === generation) options.failed()
    }
  }
  return {
    start: () => run("prepare"),
    retry: () => run("retry"),
    dispose() {
      disposed = true
      generation++
      abort?.abort()
      cancel?.()
    },
  }
}
