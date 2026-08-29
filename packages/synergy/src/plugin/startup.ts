import { ScopeStartup } from "../scope/startup"
import { Plugin } from "./index"

/**
 * H5 plugin startup contributions: scope activation and initialization move
 * out of scope/runtime.ts into the plugin domain. activate runs before any
 * starting listener (channels rely on hearing every scope start); init runs
 * right after the listeners, before session recovery. Registered through
 * src/product-registration.ts.
 */
export function registerPluginStartup() {
  ScopeStartup.register({
    name: "plugin-activate",
    phase: "core",
    before: ["starting-listeners"],
    init: (scope) => Plugin.activateScope(scope.id),
  })
  ScopeStartup.register({
    name: "plugin-init",
    phase: "core",
    after: ["starting-listeners"],
    before: ["session-recovery"],
    init: () => Plugin.init(),
    dispose: (scopeID) => Plugin.disposeScope(scopeID),
  })
}
