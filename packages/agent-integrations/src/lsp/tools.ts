import { ToolRegistry } from "@ericsanchezok/synergy-harness/tool/registry"
import { Config } from "@ericsanchezok/synergy-harness/config/config"
import { LspTool } from "./tools/lsp"

/**
 * LSP domain tool registration. Loaded through src/product-registration.ts.
 * The tool is experimental; the gate is evaluated per provider drain.
 */
let registered = false

export function registerLspTools(): void {
  if (registered) return
  registered = true

  ToolRegistry.registerToolProvider("lsp", async () => ((await Config.current()).toolExposure?.lsp ? [LspTool] : []))
}
