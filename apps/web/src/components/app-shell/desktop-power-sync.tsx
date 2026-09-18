import { createEffect, on } from "solid-js"
import { useGlobalSync } from "@/context/global-sync"
import { usePlatform } from "@/context/platform"
import { isWorkingStatus } from "@/utils/session-status"

/**
 * Notifies the Desktop shell when work starts or stops so it can re-check the
 * server's activity endpoint immediately instead of waiting for its poll.
 *
 * The renderer only ever observes the scopes it happens to have loaded, so it
 * must never report a state of its own: that would both miss scopes the UI
 * never opened and latch the assertion on if this component stopped updating.
 * The shell stays authoritative and this is a latency hint only, which is why
 * reading the process-global indexes is enough here — unlike a rendering
 * surface, a missed session only costs one poll interval of latency.
 */
export function DesktopPowerSync() {
  const platform = usePlatform()
  const globalSync = useGlobalSync()

  const hasLocalWork = () => {
    if (!platform.desktopPower) return false
    if (globalSync.data.cortex.some((task) => task.status === "running")) return true
    for (const status of Object.values(globalSync.data.sessionStatus)) {
      if (isWorkingStatus(status)) return true
    }
    return false
  }

  createEffect(
    on(hasLocalWork, () => {
      void platform.desktopPower?.activityChanged().catch(() => undefined)
    }),
  )

  return null
}
