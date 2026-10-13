import type { PluginUILifetime } from "@ericsanchezok/synergy-plugin"
import { createSignal } from "solid-js"

export function createPluginSurfaceLifetime(reportError: (error: unknown) => void) {
  const controller = new AbortController()
  const cleanups = new Set<() => void>()
  const listeners = new Set<(active: boolean) => void>()
  const [active, writeActive] = createSignal(true)
  const notify = (listener: (active: boolean) => void) => {
    try {
      listener(active())
    } catch (error) {
      reportError(error)
    }
  }
  const setActive = (value: boolean) => {
    if (controller.signal.aborted || active() === value) return
    writeActive(value)
    for (const listener of listeners) notify(listener)
  }
  const context: PluginUILifetime = {
    signal: controller.signal,
    active,
    onActivity(listener) {
      if (!controller.signal.aborted) listeners.add(listener)
      notify(listener)
      return () => {
        listeners.delete(listener)
      }
    },
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
    setActive,
    dispose() {
      if (controller.signal.aborted) return
      setActive(false)
      listeners.clear()
      controller.abort(new DOMException("Plugin surface disposed", "AbortError"))
      for (const cleanup of [...cleanups].reverse()) cleanup()
    },
  }
}
