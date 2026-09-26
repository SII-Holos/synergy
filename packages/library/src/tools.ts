import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { registerToolGroup } from "./tool-group-memory"
import { ToolRegistry } from "@ericsanchezok/synergy-harness/tool/registry"
import { MemoryWriteTool, MemoryEditTool, MemorySearchTool, MemoryGetTool } from "./tools/memory"

/**
 * Library domain tool registration. Loaded through src/product-registration.ts.
 */
const runtimeState = RuntimeContext.state(() => ({
  registered: false,
}))

export function registerLibraryTools(): void {
  const instanceState = runtimeState()

  registerToolGroup()
  if (instanceState.registered) return
  instanceState.registered = true

  ToolRegistry.registerToolProvider("library", () => [MemoryWriteTool, MemoryEditTool, MemorySearchTool, MemoryGetTool])
}
