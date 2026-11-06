import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { registerChannelToolPolicy } from "./tool-policy"
import { ToolRegistry } from "@ericsanchezok/synergy-harness/tool/registry"
import { ResponseCardTool } from "./tools/response-card"

/**
 * Channel domain tool registration. Loaded through src/registration.ts.
 */
const runtimeState = RuntimeContext.state(() => ({
  registered: false,
}))

export function registerChannelTools(): void {
  const instanceState = runtimeState()

  if (instanceState.registered) return
  instanceState.registered = true
  registerChannelToolPolicy()

  ToolRegistry.registerToolProvider("channel", () => [ResponseCardTool])
}
