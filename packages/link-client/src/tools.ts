import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { ToolRegistry } from "@ericsanchezok/synergy-harness/tool/registry"
import { ConnectTool } from "./tools/connect"

/**
 * Synergy Link domain tool registration. Loaded through src/registration.ts.
 */
const runtimeState = RuntimeContext.state(() => ({
  registered: false,
}))

export function registerSynergyLinkTools(): void {
  const instanceState = runtimeState()

  if (instanceState.registered) return
  instanceState.registered = true

  ToolRegistry.registerToolProvider("synergy-link", () => [ConnectTool])
}
