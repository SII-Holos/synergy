import { ResourceSources } from "@ericsanchezok/synergy-harness/observability/resource-sources"
import { pluginRuntimeManager } from "./plugin/runtime"

async function snapshot(): Promise<ResourceSources.Snapshot> {
  const pluginRuntimes = pluginRuntimeManager().resourceStats()
  return {
    owner: "plugin",
    ...pluginRuntimes,
    source: "plugin_monitor",
    completeness:
      pluginRuntimes.processCount === 0 || pluginRuntimes.measuredProcessCount === pluginRuntimes.processCount
        ? "full"
        : "partial",
    attributes: {},
  }
}

export function registerResourceSource() {
  ResourceSources.register("plugin", snapshot)
}
