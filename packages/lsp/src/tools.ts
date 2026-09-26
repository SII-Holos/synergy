import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { ToolRegistry } from "@ericsanchezok/synergy-harness/tool/registry"
import { Config } from "@ericsanchezok/synergy-harness/config/config"
import { LspTool } from "./tools/lsp"

/**
 * LSP domain tool registration. Loaded through src/registration.ts.
 * The tool is experimental; the gate is evaluated per provider drain.
 */
const runtimeState = RuntimeContext.state(() => ({
  registered: false,
}))

export function registerLspTools(): void {
  const instanceState = runtimeState()

  if (instanceState.registered) return
  instanceState.registered = true

  ToolRegistry.registerToolProvider("lsp", async () => ((await Config.current()).toolExposure?.lsp ? [LspTool] : []))
}
