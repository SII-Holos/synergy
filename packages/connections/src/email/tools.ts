import { registerToolGroup } from "../tool-group-email"
import { ToolRegistry } from "@ericsanchezok/synergy-harness/tool/registry"
import { EmailSendTool } from "./tools/email"
import { EmailReadTool } from "./tools/email-read"

/**
 * Email domain tool registration. Loaded through src/product-registration.ts.
 */
let registered = false

export function registerEmailTools(): void {
  registerToolGroup()
  if (registered) return
  registered = true

  ToolRegistry.registerToolProvider("email", () => [EmailSendTool, EmailReadTool])
}
