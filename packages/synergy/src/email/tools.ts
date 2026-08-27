import { ToolRegistry } from "../tool/registry"
import { EmailSendTool } from "./tools/email"
import { EmailReadTool } from "./tools/email-read"

/**
 * Email domain tool registration. Loaded through src/product-registration.ts.
 */
let registered = false

export function registerEmailTools(): void {
  if (registered) return
  registered = true

  ToolRegistry.registerToolProvider("email", () => [EmailSendTool, EmailReadTool])
}
