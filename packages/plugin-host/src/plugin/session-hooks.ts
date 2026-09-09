import { SessionPluginHooks } from "@ericsanchezok/synergy-harness/session/plugin-hooks"
import { read as readLock } from "./lockfile"
import { Plugin } from "."

/**
 * S9c source inversion: the L1 session loop delivers plugin lifecycle hooks
 * through the SessionPluginHooks registry instead of importing the plugin
 * product domain. Loaded through src/product-registration.ts.
 */
export function registerPluginSessionHooks() {
  SessionPluginHooks.registerInstalled(async () => {
    const lock = await readLock()
    return Object.entries(lock.plugins)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([id, entry]) => ({
        id,
        version: entry.version,
        generation: entry.generation,
        manifestHash: entry.manifestHash,
      }))
  })
  SessionPluginHooks.registerTrigger((point, input, initial, options) => Plugin.trigger(point, input, initial, options))
  SessionPluginHooks.registerTriggerForPlugin((pluginId, pluginGeneration, point, input, initial) =>
    Plugin.triggerForPlugin(pluginId, pluginGeneration, point, input, initial),
  )
}
