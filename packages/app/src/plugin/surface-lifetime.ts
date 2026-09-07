import type { PluginUILifetime } from "@ericsanchezok/synergy-plugin"

export function createPluginSurfaceLifetime(reportError: (error: unknown) => void) {
  const controller = new AbortController()
  const cleanups = new Set<() => void>()
  const context: PluginUILifetime = {
    signal: controller.signal,
    onDispose(cleanup) {
      let released = false
      const release = () => {
        if (released) return
        released = true
        cleanups.delete(release)
        try {
          cleanup()
        } catch (error) {
          reportError(error)
        }
      }
      if (controller.signal.aborted) release()
      else cleanups.add(release)
      return release
    },
  }
  return {
    context,
    dispose() {
      if (controller.signal.aborted) return
      controller.abort(new DOMException("Plugin surface disposed", "AbortError"))
      for (const cleanup of [...cleanups].reverse()) cleanup()
    },
  }
}
