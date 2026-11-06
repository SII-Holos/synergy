import type { PluginResourceService } from "@ericsanchezok/synergy-plugin"

export function createPluginResourceService() {
  let current: PluginResourceService["open"] | undefined
  return {
    register(open: PluginResourceService["open"]) {
      current = open
      return () => {
        if (current === open) current = undefined
      }
    },
    open(resource: Parameters<PluginResourceService["open"]>[0]) {
      if (!current) throw new Error("Resource presentation is unavailable on this page")
      return current(resource)
    },
  }
}
