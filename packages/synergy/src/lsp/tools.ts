import { ToolRegistry } from "../tool/registry"
import { Flag } from "@/flag/flag"
import { LspTool } from "./tools/lsp"

/**
 * LSP domain tool registration. Loaded through src/product-registration.ts.
 * The tool is experimental; the gate is evaluated per provider drain.
 */
let registered = false

export function registerLspTools(): void {
  if (registered) return
  registered = true

  ToolRegistry.registerToolProvider("lsp", () => (Flag.SYNERGY_EXPERIMENTAL_LSP_TOOL ? [LspTool] : []))
}
