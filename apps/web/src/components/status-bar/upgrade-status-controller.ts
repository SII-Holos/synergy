import type { StorageUpgradeStatus } from "@ericsanchezok/synergy-sdk/client"

export function createUpgradeStatusController(options: {
  load(): Promise<StorageUpgradeStatus | undefined>
  publish(status: StorageUpgradeStatus | undefined): void
  hidden(): boolean
  schedule?: (callback: () => void, delay: number) => () => void
}) {
  let disposed = false
  let cancel: (() => void) | undefined
  const schedule =
    options.schedule ??
    ((callback: () => void, delay: number) => {
      const timer = setTimeout(callback, delay)
      return () => clearTimeout(timer)
    })
  async function refresh() {
    if (disposed) return
    cancel?.()
    cancel = undefined
    try {
      const status = await options.load()
      if (disposed) return
      options.publish(status)
      if (!status || !(status.pending + status.partial)) return
    } catch {
      if (disposed) return
    }
    cancel = schedule(() => void refresh(), options.hidden() ? 10_000 : 2000)
  }
  return {
    refresh,
    dispose() {
      disposed = true
      cancel?.()
      cancel = undefined
    },
  }
}
