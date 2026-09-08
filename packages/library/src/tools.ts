import { registerToolGroup } from "./tool-group-memory"
import { ToolRegistry } from "@ericsanchezok/synergy-harness/tool/registry"
import { MemoryWriteTool, MemoryEditTool, MemorySearchTool, MemoryGetTool } from "./tools/memory"

/**
 * Library domain tool registration. Loaded through src/product-registration.ts.
 */
let registered = false

export function registerLibraryTools(): void {
  registerToolGroup()
  if (registered) return
  registered = true

  ToolRegistry.registerToolProvider("library", () => [MemoryWriteTool, MemoryEditTool, MemorySearchTool, MemoryGetTool])
}
