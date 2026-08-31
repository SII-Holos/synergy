import { ToolRegistry } from "../tool/registry"
import { MemoryWriteTool, MemoryEditTool, MemorySearchTool, MemoryGetTool } from "./tools/memory"

/**
 * Library domain tool registration. Loaded through src/product-registration.ts.
 */
let registered = false

export function registerLibraryTools(): void {
  if (registered) return
  registered = true

  ToolRegistry.registerToolProvider("library", () => [MemoryWriteTool, MemoryEditTool, MemorySearchTool, MemoryGetTool])
}
