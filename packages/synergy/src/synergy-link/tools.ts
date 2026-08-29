import { ToolRegistry } from "../tool/registry"
import { ConnectTool } from "./tools/connect"

/**
 * Synergy Link domain tool registration. Loaded through src/product-registration.ts.
 */
let registered = false

export function registerSynergyLinkTools(): void {
  if (registered) return
  registered = true

  ToolRegistry.registerToolProvider("synergy-link", () => [ConnectTool])
}
