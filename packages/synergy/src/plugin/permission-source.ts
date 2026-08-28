import { PermissionPluginSource } from "../permission/plugin-source"
import { Plugin } from "./index"

/**
 * S9d source inversion: the L1 permission ask pipeline delivers the
 * permission.ask hook to plugins through this registered source. Loaded
 * through src/product-registration.ts.
 */
export function registerPermissionPluginSource() {
  PermissionPluginSource.register({
    triggerAsk: (info, initial) => Plugin.trigger("permission.ask", info, initial),
  })
}
