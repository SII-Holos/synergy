import type { ResourceHost } from "@ericsanchezok/synergy-harness/resources/host"
import type { ResourceSnapshot } from "@ericsanchezok/synergy-harness/resources/schema"
import { linuxResources } from "./linux"

export function nativeResources(): ResourceHost.Source {
  let source: ResourceHost.Source | undefined
  let observer: (() => void) | undefined
  let stopObservation: (() => void) | undefined
  return {
    async sample(): Promise<ResourceSnapshot> {
      if (!source) {
        source =
          process.platform === "darwin"
            ? (await import("./darwin")).darwinResources()
            : process.platform === "win32"
              ? (await import("./windows")).windowsResources()
              : linuxResources()
        if (observer) stopObservation = source.observe?.(observer)
      }
      return source.sample()
    },
    observe(changed) {
      observer = changed
      return () => {
        observer = undefined
        stopObservation?.()
      }
    },
    close() {
      stopObservation?.()
      source?.close?.()
    },
  }
}
