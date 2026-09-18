import { createEffect, on } from "solid-js"
import { useGlobalSync } from "@/context/global-sync"
import { usePlatform } from "@/context/platform"
import { HOME_SCOPE_KEY } from "@/utils/scope"

/**
 * Notifies the Desktop shell when work starts or stops so it can re-check the
 * server's activity endpoint immediately instead of waiting for its poll.
 *
 * The renderer only ever observes the scopes it happens to have loaded, so it
 * must never report a state of its own: that would both miss scopes the UI
 * never opened and latch the assertion on if this component stopped updating.
 * The shell stays authoritative and this is a latency hint only.
 */
export function DesktopPowerSync() {
  const platform = usePlatform()
  const globalSync = useGlobalSync()

  const hasLocalWork = () => {
    if (!platform.desktopPower) return false
    const scopeKeys = [HOME_SCOPE_KEY, ...globalSync.data.scope.map((scope) => scope.worktree)]
    for (const scopeKey of scopeKeys) {
      const store = globalSync.peekScopeState(scopeKey)?.[0]
      if (!store) continue
      for (const status of Object.values(store.session_status)) {
        if (status.type !== "idle") return true
      }
      if (store.cortex.some((task) => task.status === "running")) return true
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
