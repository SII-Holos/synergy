import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { registerToolGroup } from "../tool-group-email"
import { ToolRegistry } from "@ericsanchezok/synergy-harness/tool/registry"
import { EmailSendTool } from "./tools/email"
import { EmailReadTool } from "./tools/email-read"

/**
 * Email domain tool registration. Loaded through src/product-registration.ts.
 */
const runtimeState = RuntimeContext.state(() => ({
  registered: false,
}))

export function registerEmailTools(): void {
  const instanceState = runtimeState()

  registerToolGroup()
  if (instanceState.registered) return
  instanceState.registered = true

  ToolRegistry.registerToolProvider("email", () => [EmailSendTool, EmailReadTool])
}
