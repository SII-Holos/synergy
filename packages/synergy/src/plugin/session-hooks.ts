import { SessionPluginHooks } from "../session/plugin-hooks"
import { Plugin } from "./index"

/**
 * S9c source inversion: the L1 session loop delivers plugin lifecycle hooks
 * through the SessionPluginHooks registry instead of importing the plugin
 * product domain. Loaded through src/product-registration.ts.
 */
export function registerPluginSessionHooks() {
  SessionPluginHooks.registerTrigger((point, input, initial, options) => Plugin.trigger(point, input, initial, options))
  SessionPluginHooks.registerTriggerForPlugin((pluginId, pluginGeneration, point, input, initial) =>
    Plugin.triggerForPlugin(pluginId, pluginGeneration, point, input, initial),
  )
}
